import { escapeHtml } from "../../ui/html.mjs";
export function createSignupForm({ db, config, accounts, fields }) {
  const signupForm = (flow, browser) => {
    const pending = flow.authEmail ? accounts.get(flow.authEmail) : null;
    const retry = pending?.status === "provisioning";
    const available = config.publicHandles?.filter(
      (handle) => !accounts.get(handle),
    );
    const initialHandle = retry ? pending.handle : (available?.[0] ?? "");
    const handleHelp = config.publicHandles
      ? `Available public test handles: ${available?.map(escapeHtml).join(", ") || "all current handles are reserved; sign in to an existing account"}.`
      : `Use a name ending in ${escapeHtml(config.handleDomains?.[0] ?? ".entryway.test")}.`;
    const suggestions = config.publicHandles
      ? `<datalist id="public-handles">${available?.map((handle) => `<option value="${escapeHtml(handle)}">`).join("") ?? ""}</datalist>`
      : "";
    const reservedInvite = flow.authEmail
      ? db.get("entryway:invite-reservations", flow.authEmail)?.code
      : undefined;
    const inviteInput =
      config.inviteCodeRequired ||
      config.invites ||
      db.list("entryway:invites").length
        ? `<label for="inviteCode">Invite code${config.inviteCodeRequired ? "" : " (optional)"}</label><input id="inviteCode" name="inviteCode" value="${escapeHtml(reservedInvite ?? "")}" ${config.inviteCodeRequired ? "required" : ""} ${reservedInvite ? "readonly" : ""}>`
        : "";
    return `<p>${retry ? "Your account setup is unfinished. Retry the saved handle and data server." : "Your email is verified. Choose where your data will live."}</p><form method="post" action="/auth/account">${fields(flow, browser)}<label for="handle">Handle</label><input id="handle" name="handle" placeholder="${escapeHtml(config.publicHandles?.[0] ?? "alice.entryway.test")}" value="${escapeHtml(initialHandle)}" ${retry ? "readonly" : ""} ${config.publicHandles ? 'list="public-handles"' : ""} required>${suggestions}<small>${handleHelp}</small><label for="pdsId">Personal data server</label><select id="pdsId" name="pdsId" ${retry ? "disabled" : ""}>${config.pds.map((p) => `<option value="${escapeHtml(p.id)}"${retry && p.id === pending.pdsId ? " selected" : ""}>${escapeHtml(p.id)} — ${escapeHtml(p.url)}</option>`).join("")}</select>${inviteInput}<button>${retry ? "Retry account setup" : "Create account"}</button></form>`;
  };
  return signupForm;
}
