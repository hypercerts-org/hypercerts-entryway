import { InvalidRequestError } from "@atproto/oauth-provider/errors";
import { ChangedFlowIntentError } from "../../http/browser-flow.mjs";
import { page } from "../../ui/html.mjs";
const RESEND_COOLDOWN = 5_000;
export function mountEmailLogin({
  app,
  db,
  accounts,
  authentication,
  mail,
  flows,
  forms,
  signupForm,
  authenticated,
  getAccountSecurity,
  forgetBrowserAccounts,
}) {
  const {
    fields,
    save,
    newFlow,
    getFlow,
    refreshFlow,
    readCurrentIntent,
    loadBrowser,
    checkCsrf,
    pageForFlow,
    guarded,
    form,
  } = flows;
  const { loginForm, otpForm } = forms;
  const sendCode = async (res, flow, browser, emailValue) => {
    let email;
    let reserved;
    let preparingMail = false;
    try {
      reserved = await db.transact(async () => {
        // getFlow authenticated this flow before yielding. Refresh its mutable
        // request counters and intent under the same lock as the shared budget.
        flow = await refreshFlow(flow, browser);
        email = String(emailValue ?? flow.email ?? "")
          .trim()
          .toLowerCase();
        if (!email && emailValue === undefined)
          throw new InvalidRequestError("Request a sign-in code first");
        if (
          !email ||
          email.length > 320 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        )
          throw new InvalidRequestError("Enter a valid email address");
        const now = Date.now();
        if (flow.otpRequestCount >= 5) return { reason: "flow-limit" };
        if (flow.lastOtpSentAt && now - flow.lastOtpSentAt < RESEND_COOLDOWN)
          return { reason: "cooldown" };
        const limitKey = `${email}/${Math.floor(now / 600_000)}`;
        const count = (await db.get("otp-limits", limitKey)) ?? 0;
        if (count >= 5) return { reason: "email-limit" };
        if (flow.email && flow.email !== email)
          await mail.supersedeOtp({ email: flow.email, type: "sign-in" });
        await db.set("otp-limits", limitKey, count + 1);
        flow.email = email;
        flow.otpRequestCount = (flow.otpRequestCount ?? 0) + 1;
        flow.lastOtpSentAt = now;
        delete flow.authDid;
        delete flow.authEmail;
        await save(flow);
        // Verification and outbox queue belong to this reservation. The returned
        // dispatcher performs SMTP only after the outer transaction commits.
        preparingMail = true;
        const dispatch = await authentication.queueSignInCode(email);
        preparingMail = false;
        return { dispatch };
      });
      const refusal = {
        "flow-limit": [
          "Code request limit reached",
          "Too many code requests for this sign-in. Start again later.",
        ],
        cooldown: [
          "Wait before requesting another code",
          "Wait five seconds before requesting another code.",
        ],
        "email-limit": [
          "Try again later",
          "Too many codes were requested for this email. Wait ten minutes.",
        ],
      }[reserved.reason];
      if (refusal)
        return pageForFlow(
          res,
          refusal[0],
          otpForm(flow, browser, refusal[1], email),
          flow,
          429,
        );
      await reserved.dispatch.deliver();
    } catch (error) {
      if (!reserved && !preparingMail) throw error;
      return pageForFlow(
        res,
        "Code not delivered",
        otpForm(
          flow,
          browser,
          "The email service could not deliver your code. Wait five seconds and try again.",
          email,
        ),
        flow,
        503,
      );
    }
    return pageForFlow(res, "Check your email", otpForm(flow, browser), flow);
  };
  app.get(
    "/login",
    guarded(async (req, res) => {
      const browser = await loadBrowser(req, res);
      const flow = await newFlow(browser);
      page(res, "Sign in", loginForm(flow, browser));
    }),
  );
  app.post(
    "/auth/email",
    form,
    guarded(async (req, res) => {
      const { flow, browser } = await getFlow(req, res);
      await sendCode(res, flow, browser, String(req.body.email ?? ""));
    }),
  );
  app.post(
    "/auth/resend",
    form,
    guarded(async (req, res) => {
      const { flow, browser } = await getFlow(req, res);
      await sendCode(res, flow, browser);
    }),
  );
  app.post(
    "/auth/verify",
    form,
    guarded(async (req, res) => {
      try {
        const { flow, browser } = await getFlow(req, res);
        if (!flow.email)
          throw new InvalidRequestError("Request a sign-in code first");
        const response = await authentication.verifySignInCode({
          email: flow.email,
          otp: String(req.body.otp ?? "").trim(),
        });
        if (!response.ok)
          return pageForFlow(
            res,
            "Check your email",
            otpForm(
              flow,
              browser,
              "Invalid or expired code. Please try again.",
            ),
            flow,
            400,
          );
        const identity = response.principal;
        if (
          !identity?.emailVerified ||
          identity.email.toLowerCase() !== flow.email
        )
          throw new InvalidRequestError("Email verification did not complete");
        await db.transact(async () => {
          await readCurrentIntent(flow, browser);
          await getAccountSecurity()?.assertLoginEmail({
            email: flow.email,
            userId: identity.userId,
          });
        });
        // Rotate the provider's browser session after successful identity verification.
        const rotated = await loadBrowser(req, res, true);
        const verifiedEmail = identity.email.toLowerCase();
        const row = await accounts.get(verifiedEmail);
        if (!row || row.status === "provisioning") {
          const body = await signupForm(
            { ...flow, authEmail: verifiedEmail },
            rotated,
          );
          const current = await db.transact(async () => {
            const current = await readCurrentIntent(flow, rotated);
            current.authEmail = verifiedEmail;
            await save(current);
            return current;
          });
          response.commitCookies(res);
          return pageForFlow(res, "Create your account", body, current);
        }
        await authenticated(req, res, flow, rotated, row, {
          verifiedEmail,
          commitCookies: () => response.commitCookies(res),
        });
      } catch (error) {
        if (!(error instanceof ChangedFlowIntentError)) throw error;
        return pageForFlow(
          res,
          "Use your latest email code",
          otpForm(error.flow, error.browser, error.message),
          error.flow,
          400,
        );
      }
    }),
  );
  app.post(
    "/auth/logout",
    form,
    guarded(async (req, res) => {
      const browser = await loadBrowser(req, res);
      checkCsrf(req, browser);
      await forgetBrowserAccounts(browser.deviceId);
      await authentication.endSession(req, res);
      res.redirect(303, "/login");
    }),
  );
}
