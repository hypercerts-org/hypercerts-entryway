import { InvalidRequestError } from "@atproto/oauth-provider/errors";
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
    loadBrowser,
    checkCsrf,
    pageForFlow,
    guarded,
    form,
  } = flows;
  const { loginForm, otpForm } = forms;
  const sendCode = async (res, flow, browser, emailValue) => {
    const email = String(emailValue ?? "")
      .trim()
      .toLowerCase();
    if (
      !email ||
      email.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    )
      throw new InvalidRequestError("Enter a valid email address");
    const now = Date.now();
    if (flow.otpRequestCount >= 5)
      return pageForFlow(
        res,
        "Code request limit reached",
        otpForm(
          flow,
          browser,
          "Too many code requests for this sign-in. Start again later.",
          email,
        ),
        flow,
        429,
      );
    if (flow.lastOtpSentAt && now - flow.lastOtpSentAt < RESEND_COOLDOWN)
      return pageForFlow(
        res,
        "Wait before requesting another code",
        otpForm(
          flow,
          browser,
          "Wait five seconds before requesting another code.",
          email,
        ),
        flow,
        429,
      );
    const limitKey = `${email}/${Math.floor(now / 600_000)}`;
    const count = db.get("otp-limits", limitKey) ?? 0;
    if (count >= 5)
      return pageForFlow(
        res,
        "Try again later",
        otpForm(
          flow,
          browser,
          "Too many codes were requested for this email. Wait ten minutes.",
          email,
        ),
        flow,
        429,
      );
    if (flow.email && flow.email !== email)
      mail.supersedeOtp({ email: flow.email, type: "sign-in" });
    db.set("otp-limits", limitKey, count + 1);
    flow.email = email;
    flow.otpRequestCount = (flow.otpRequestCount ?? 0) + 1;
    flow.lastOtpSentAt = now;
    delete flow.authDid;
    delete flow.authEmail;
    save(flow);
    try {
      await authentication.sendSignInCode(email);
    } catch {
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
      const flow = newFlow(browser);
      page(res, "Sign in", loginForm(flow, browser));
    }),
  );
  app.post(
    "/auth/email",
    form,
    guarded(async (req, res) => {
      const { flow, browser } = await getFlow(req, res);
      await sendCode(res, flow, browser, req.body.email);
    }),
  );
  app.post(
    "/auth/resend",
    form,
    guarded(async (req, res) => {
      const { flow, browser } = await getFlow(req, res);
      if (!flow.email)
        throw new InvalidRequestError("Request a sign-in code first");
      await sendCode(res, flow, browser, flow.email);
    }),
  );
  app.post(
    "/auth/verify",
    form,
    guarded(async (req, res) => {
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
          otpForm(flow, browser, "Invalid or expired code. Please try again."),
          flow,
          400,
        );
      const identity = response.principal;
      if (
        !identity?.emailVerified ||
        identity.email.toLowerCase() !== flow.email
      )
        throw new InvalidRequestError("Email verification did not complete");
      getAccountSecurity()?.assertLoginEmail({
        email: flow.email,
        userId: identity.userId,
      });
      response.commitCookies(res);
      // Rotate the provider's browser session after successful identity verification.
      const rotated = await loadBrowser(req, res, true);
      flow.authEmail = identity.email.toLowerCase();
      save(flow);
      const row = accounts.get(flow.authEmail);
      if (!row || row.status === "provisioning")
        return pageForFlow(
          res,
          "Create your account",
          signupForm(flow, rotated),
          flow,
        );
      await authenticated(req, res, flow, rotated, row);
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
