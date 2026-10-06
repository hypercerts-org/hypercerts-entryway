import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import { emailOTP } from "better-auth/plugins";

/** @returns {Promise<import('./port.js').BrowserAuthentication>} */
export async function createBetterAuthAuthentication({ db, config, mail }) {
  const origin = new URL(config.issuer).origin;
  const verificationMail = new AsyncLocalStorage();
  const authOptions = {
    secret: config.betterAuthSecret,
    database: db.authenticationAdapter,
    baseURL: config.issuer,
    basePath: "/api/auth",
    trustedOrigins: [origin],
    emailAndPassword: { enabled: false },
    session: { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
    advanced: {
      useSecureCookies: new URL(config.issuer).protocol === "https:",
    },
    plugins: [
      emailOTP({
        otpLength: 8,
        expiresIn: 600,
        allowedAttempts: 5,
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp, type }) {
          const scope = verificationMail.getStore();
          if (!scope) throw new Error("MissingVerificationMailScope");
          try {
            scope.dispatch = await mail.queueOtp({ email, otp, type });
          } catch (error) {
            // Better Auth deliberately catches mail callback failures. Retain the
            // error for the public API wrapper so verification and queue roll back.
            scope.failure = error;
          }
        },
      }),
    ],
  };
  const auth = betterAuth(authOptions);
  const headers = (req) => fromNodeHeaders(req.headers);
  const principal = (value) =>
    value
      ? {
          userId: value.user.id,
          email: value.user.email.toLowerCase(),
          emailVerified: value.user.emailVerified,
          sessionId: value.session.id,
          authenticatedAt: new Date(value.session.createdAt),
          kind: "better-auth",
        }
      : null;
  const appendCookies = (res, response) => {
    for (const value of response.headers.getSetCookie())
      res.append("Set-Cookie", value);
  };
  const queueSignInCode = async (email) => {
    const scope = { dispatch: null, failure: null };
    await db.transact(() =>
      verificationMail.run(scope, async () => {
        await auth.api.sendVerificationOTP({
          body: { email, type: "sign-in" },
        });
        if (scope.failure) throw scope.failure;
      }),
    );
    if (!scope.dispatch) throw new Error("MissingVerificationMailDispatch");
    return scope.dispatch;
  };
  return {
    async requireSession(req) {
      return await principal(
        await auth.api.getSession({ headers: headers(req) }),
      );
    },
    queueSignInCode,
    async sendSignInCode(email) {
      await (await queueSignInCode(email)).deliver();
    },
    async verifySignInCode({ email, otp }) {
      // The provider consumes first, then recreates the verification on a wrong
      // guess. Keep that whole supported operation ordered with issuance.
      // asResponse preserves expected 4xx results so invalid-attempt writes commit.
      const response = await db.transact(() =>
        auth.api.signInEmailOTP({
          body: { email, otp },
          asResponse: true,
        }),
      );
      if (!response.ok) return { ok: false, status: response.status };
      const value = await response.json();
      return {
        ok: true,
        status: response.status,
        principal: value.user
          ? {
              userId: value.user.id,
              email: value.user.email.toLowerCase(),
              emailVerified: value.user.emailVerified,
            }
          : null,
        // The caller asserts account ownership before committing the browser cookie.
        commitCookies: (res) => appendCookies(res, response),
      };
    },
    async endSession(req, res) {
      const response = await auth.api.signOut({
        headers: headers(req),
        asResponse: true,
      });
      appendCookies(res, response);
    },
    async listBrowserSessions(req) {
      return (await auth.api.listSessions({ headers: headers(req) })).map(
        ({ id, userAgent, createdAt, expiresAt }) => ({
          id,
          userAgent,
          createdAt,
          expiresAt,
        }),
      );
    },
    async revokeBrowserSession(req, sessionId) {
      const item = (
        await auth.api.listSessions({ headers: headers(req) })
      ).find((session) => session.id === sessionId);
      if (!item) {
        const error = new Error("Browser session not found");
        error.status = 404;
        error.error = "NotFound";
        throw error;
      }
      await auth.api.revokeSession({
        headers: headers(req),
        body: { token: item.token },
      });
    },
    async revokeBrowserSessions(req) {
      await auth.api.revokeSessions({ headers: headers(req) });
    },
  };
}
