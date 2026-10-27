import { InvalidRequestError } from "@atproto/oauth-provider/errors";
import { accountEmailSchema } from "../../accounts/input-schema.js";
import { ChangedFlowIntentError } from "../../http/browser-flow.mjs";
import { matchesAuthorizationHint } from "../../accounts/rules.js";
import { page } from "../../ui/html.mjs";
const RESEND_COOLDOWN = 5_000;
const loginHints = (flow) =>
  [flow.accountHint, flow.parameters?.login_hint].filter(
    (hint) => hint != null,
  );
const matchesLoginHint = (flow, account) =>
  matchesAuthorizationHint(account, ...loginHints(flow));
const linkedAccounts = (resolution) => {
  if (resolution?.kind === "single") return [resolution.account];
  if (resolution?.kind === "selection-required") return resolution.accounts;
  return [];
};

export function mountEmailLogin({
  app,
  db,
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
        if (emailValue === undefined && !flow.email)
          throw new InvalidRequestError("Request a sign-in code first");
        const input = accountEmailSchema.safeParse(
          emailValue === undefined ? flow.email : emailValue,
        );
        if (!input.success)
          throw new InvalidRequestError("Enter a valid email address");
        email = input.data;
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
        delete flow.authUserId;
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
      const requestedDid = req.query?.did;
      if (
        requestedDid !== undefined &&
        (typeof requestedDid !== "string" ||
          requestedDid.length > 255 ||
          !requestedDid.startsWith("did:"))
      )
        throw new InvalidRequestError("Invalid requested account for sign-in");
      const flow = await newFlow(browser, {
        ...(requestedDid ? { accountHint: requestedDid } : {}),
      });
      page(res, "Sign in", loginForm(flow, browser));
    }),
  );
  app.post(
    "/auth/email",
    form,
    guarded(async (req, res) => {
      const { flow, browser } = await getFlow(req, res);
      await sendCode(res, flow, browser, req.body.email ?? "");
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
        let resolution;
        let verifiedFlow;
        let selectionAccounts;
        let hintMismatch = false;
        await db.transact(async () => {
          const current = await readCurrentIntent(flow, browser);
          resolution = await getAccountSecurity()?.assertLoginEmail(identity);
          if (resolution?.kind === "selection-required") {
            selectionAccounts = resolution.accounts.filter((account) =>
              matchesLoginHint(current, account),
            );
            if (loginHints(current).length > 0 && selectionAccounts.length === 0) {
              hintMismatch = true;
              return;
            }
            current.authEmail = identity.email.toLowerCase();
            current.authUserId = identity.userId;
            await save(current);
            verifiedFlow = current;
          } else if (
            resolution?.kind === "single" &&
            !matchesLoginHint(current, resolution.account)
          ) {
            hintMismatch = true;
          } else if (
            resolution?.kind === "unbound" &&
            loginHints(current).some(
              (hint) => typeof hint === "string" && hint.startsWith("did:"),
            )
          ) {
            hintMismatch = true;
          }
        });
        // Rotate the provider's browser session after successful identity verification.
        const rotated = await loadBrowser(req, res, true);
        const verifiedEmail = identity.email.toLowerCase();
        if (hintMismatch)
          return pageForFlow(
            res,
            "Account not linked",
            '<p role="alert">Your verified email is not linked to the requested account. Use the email associated with that account.</p>',
            flow,
            403,
          );
        if (resolution?.kind === "account-requires-repair")
          return pageForFlow(
            res,
            "Account requires repair",
            '<p role="alert">This email is associated with an existing account that needs repair before sign-in can continue. Signup is unavailable for this email. Contact support for help.</p>',
            flow,
            409,
          );
        if (
          !resolution ||
          resolution.kind === "unbound" ||
          (resolution.kind === "single" &&
            resolution.account.status === "provisioning")
        ) {
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
        if (resolution.kind === "selection-required") {
          response.commitCookies(res);
          return pageForFlow(
            res,
            "Choose an account",
            forms.accountSelectionForm(
              verifiedFlow,
              rotated,
              selectionAccounts,
            ),
            verifiedFlow,
          );
        }
        await authenticated(req, res, flow, rotated, resolution.account, {
          identity,
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
  // The flow keeps authUserId until consent is approved or denied, so the
  // verified browser identity can change its choice before granting access.
  const requireChooserIdentity = async (req, flow) => {
    const session = await authentication.requireSession(req);
    if (
      !flow.authEmail ||
      !flow.authUserId ||
      session?.emailVerified !== true ||
      session.userId !== flow.authUserId ||
      session.email.toLowerCase() !== flow.authEmail
    )
      throw new InvalidRequestError("Verified sign-in session expired");
    return {
      userId: session.userId,
      email: session.email.toLowerCase(),
      emailVerified: true,
    };
  };
  app.post(
    "/auth/choose",
    form,
    guarded(async (req, res) => {
      const { flow, browser } = await getFlow(req, res);
      const identity = await requireChooserIdentity(req, flow);
      const resolution = await getAccountSecurity()?.assertLoginEmail(identity);
      if (resolution?.kind !== "selection-required")
        throw new InvalidRequestError("No other linked account is available");
      return pageForFlow(
        res,
        "Choose an account",
        forms.accountSelectionForm(
          flow,
          browser,
          resolution.accounts.filter((account) =>
            matchesLoginHint(flow, account),
          ),
        ),
        flow,
      );
    }),
  );
  app.post(
    "/auth/select",
    form,
    guarded(async (req, res) => {
      const { flow, browser } = await getFlow(req, res);
      const identity = await requireChooserIdentity(req, flow);
      const selectedDid = String(req.body.did ?? "");
      let current;
      let selected;
      await db.transact(async () => {
        current = await readCurrentIntent(flow, browser);
        if (
          current.authEmail !== identity.email ||
          current.authUserId !== identity.userId
        )
          throw new InvalidRequestError(
            "This account choice is no longer valid",
          );
        const resolution =
          await getAccountSecurity()?.assertLoginEmail(identity);
        selected = linkedAccounts(resolution).find(
          (account) =>
            account.did === selectedDid &&
            matchesLoginHint(current, account),
        );
        if (!selected)
          throw new InvalidRequestError(
            "The selected account is not linked to this verified identity",
          );
      });
      await authenticated(req, res, current, browser, selected, {
        identity,
        fromChooser: true,
      });
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
