import { InvalidRequestError } from "@atproto/oauth-provider/errors";
import { HttpError } from "../../http/http-error.mjs";
import { escapeHtml } from "../../ui/html.mjs";
async function registrationInput({
  db,
  existing,
  savedIntent,
  email,
  body,
  registrationIdentity,
}) {
  if (existing)
    return {
      email: existing.email,
      handle: existing.handle,
      pdsId: existing.pdsId,
      recoveryKey: existing.recoveryKey,
      inviteCode:
        (await db.get("entryway:invite-reservations", existing.email))?.code ??
        body.inviteCode,
      registrationIdentity,
    };
  return {
    email,
    recoveryKey: savedIntent?.recoveryKey ?? undefined,
    handle: String(savedIntent?.handle ?? body.handle ?? "")
      .trim()
      .toLowerCase(),
    pdsId: String(savedIntent?.pdsId ?? body.pdsId ?? ""),
    inviteCode: body.inviteCode,
    registrationIdentity,
  };
}

function matchesRegistrationOwner(owner, session, email) {
  return (
    owner?.kind === "better-auth" &&
    owner.userId === session.userId &&
    owner.email === email
  );
}

export function mountSignupRoutes({
  app,
  db,
  accounts,
  accountAccess,
  authentication,
  flows,
  signupForm,
  authenticated,
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
      const email = session.email.toLowerCase();
      const identity = {
        kind: "better-auth",
        userId: session.userId,
        email,
        emailVerified: true,
      };
      const existing = await accounts.get(flow.authEmail);
      const savedIntent = await accounts.pendingRegistration(flow.authEmail);
      const savedOwner = savedIntent?.registrationIdentity;
      const ownerMatches = matchesRegistrationOwner(savedOwner, session, email);
      if (existing?.status === "active") {
        const row = await accountAccess.requireBoundAccount(
          identity,
          existing.did,
        );
        return await authenticated(req, res, flow, browser, row, { identity });
      }
      if (existing && existing.status !== "provisioning")
        throw new HttpError(
          409,
          "AccountUnavailable",
          "This account cannot be registered again",
        );
      if (savedIntent && !ownerMatches)
        throw new HttpError(
          403,
          "AccountMismatch",
          "This saved registration belongs to a different verified identity",
        );
      if (existing && (!savedIntent || !ownerMatches))
        throw new HttpError(
          403,
          "AccountMismatch",
          "This account setup cannot be acquired through email sign-in",
        );
      const registrationIdentity = savedOwner ?? identity;
      let row;
      try {
        row = await accounts.create(
          await registrationInput({
            db,
            existing,
            savedIntent,
            email: flow.authEmail,
            body: req.body,
            registrationIdentity,
          }),
        );
      } catch (error) {
        const pending = await accounts.ownership.pendingExternal(
          `email:${flow.authEmail}`,
        );
        const message =
          pending?.state === "dispatched"
            ? "Account setup is saved and waiting for operator recovery. Contact the service operator; retrying alone cannot resolve this pending request."
            : error.message;
        return pageForFlow(
          res,
          "Create your account",
          `<p role="alert">${escapeHtml(message)}</p>${await signupForm(flow, browser)}`,
          flow,
          error.status >= 400 && error.status < 600 ? error.status : 503,
        );
      }
      await authenticated(req, res, flow, browser, row, { identity });
    }),
  );
}
