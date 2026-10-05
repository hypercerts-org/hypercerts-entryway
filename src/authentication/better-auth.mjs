import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { fromNodeHeaders } from "better-auth/node";
import { emailOTP } from "better-auth/plugins";

/** @returns {Promise<import('./port.js').BrowserAuthentication>} */
export async function createBetterAuthAuthentication({ db, config, mail }) {
  const origin = new URL(config.issuer).origin;
  const authOptions = {
    secret: config.betterAuthSecret,
    database: db.sqlite,
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
          await mail.sendOtp({ email, otp, type });
        },
      }),
    ],
  };
  // Better Auth 1.7 eagerly validates its schema during construction.
  // Finish startup migrations before that validation can inspect a partial schema.
  const migration = await getMigrations(authOptions);
  await migration.runMigrations();
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
  return {
    async requireSession(req) {
      return principal(await auth.api.getSession({ headers: headers(req) }));
    },
    async sendSignInCode(email) {
      await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    },
    async verifySignInCode({ email, otp }) {
      const response = await auth.api.signInEmailOTP({
        body: { email, otp },
        asResponse: true,
      });
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
