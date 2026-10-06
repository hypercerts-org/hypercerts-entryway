import { InvalidRequestError } from "@atproto/oauth-provider/errors";
import { escapeHtml } from "../../ui/html.mjs";
export function mountSignupRoutes({
  app,
  db,
  accounts,
  authentication,
  flows,
  signupForm,
  authenticated,
  getAccountSecurity,
}) {
  const { getFlow, pageForFlow, guarded, form } = flows;
  app.post(
    "/auth/account",
    form,
    guarded(async (req, res) => {
      const { flow, browser } = await getFlow(req, res);
      if (!flow.authEmail)
        throw new InvalidRequestError(
          "Verify your email before creating an account",
        );
      const session = await authentication.requireSession(req);
      if (
        session?.email.toLowerCase() !== flow.authEmail ||
        !session.emailVerified
      )
        throw new InvalidRequestError("Sign-in session expired");
      const existing = await accounts.get(flow.authEmail);
      let row = existing;
      if (!existing || existing.status === "provisioning") {
        try {
          row = await accounts.create(
            existing
              ? {
                  email: existing.email,
                  handle: existing.handle,
                  pdsId: existing.pdsId,
                  inviteCode:
                    (
                      await db.get(
                        "entryway:invite-reservations",
                        existing.email,
                      )
                    )?.code ?? req.body.inviteCode,
                }
              : {
                  email: flow.authEmail,
                  handle: String(req.body.handle ?? "")
                    .trim()
                    .toLowerCase(),
                  pdsId: String(req.body.pdsId ?? ""),
                  inviteCode: req.body.inviteCode,
                },
          );
        } catch (error) {
          return pageForFlow(
            res,
            "Create your account",
            `<p role="alert">${escapeHtml(error.message)}</p>${await signupForm(flow, browser)}`,
            flow,
            error.status >= 400 && error.status < 600 ? error.status : 503,
          );
        }
      }
      await getAccountSecurity()?.bindVerifiedIdentity({
        did: row.did,
        email: session.email.toLowerCase(),
        userId: session.userId,
      });
      await authenticated(req, res, flow, browser, row);
    }),
  );
}
