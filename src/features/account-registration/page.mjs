import { escapeHtml } from "../../ui/html.mjs";
import { registrationAccountForEmail } from "./create-account.js";
const signupState = (recoveryRequired, retry) => {
  if (recoveryRequired)
    return {
      intro:
        "Your account setup is saved and waiting for operator recovery. Contact the service operator; retrying alone cannot resolve an uncertain server request. Your saved identity and data server will be preserved.",
      button: "Waiting for operator recovery",
    };
  if (retry)
    return {
      intro:
        "Your account setup is unfinished. Retry the saved handle and data server.",
      button: "Retry account setup",
    };
  return {
    intro: "Your email is verified. Choose where your data will live.",
    button: "Create account",
  };
};

export function createSignupForm({ db, config, accounts, fields }) {
  const signupForm = async (flow, browser) => {
    const account = flow.authEmail
      ? await registrationAccountForEmail(accounts.storage, flow.authEmail)
      : null;
    const attempt = flow.authEmail
      ? await accounts.ownership?.pendingExternal(`email:${flow.authEmail}`)
      : null;
    const pending =
      account ??
      (flow.authEmail
        ? await accounts.pendingRegistration?.(flow.authEmail)
        : null);
    const retry =
      account?.status === "provisioning" || Boolean(!account && pending);
    const requestedHint = flow.accountHint ?? flow.parameters?.login_hint;
    const hintedHandle =
      typeof requestedHint === "string" && !requestedHint.startsWith("did:")
        ? requestedHint.toLowerCase()
        : null;
    const recoveryRequired = attempt?.state === "dispatched";
    const available = [];
    for (const handle of config.publicHandles ?? []) {
      if (!(await accounts.get(handle))) available.push(handle);
    }
    const initialHandle = retry
      ? pending.handle
      : (hintedHandle ?? available?.[0] ?? "");
    const handleHelp = config.publicHandles
      ? `Available public test handles: ${available?.map(escapeHtml).join(", ") || "all current handles are reserved; sign in to an existing account"}.`
      : `Use a name ending in ${escapeHtml(config.handleDomains?.[0] ?? ".entryway.test")}.`;
    const suggestions = config.publicHandles
      ? `<datalist id="public-handles">${available?.map((handle) => `<option value="${escapeHtml(handle)}">`).join("") ?? ""}</datalist>`
      : "";
    const reservedInvite = flow.authEmail
      ? (await db.get("entryway:invite-reservations", flow.authEmail))?.code
      : undefined;
    const inviteInput =
      config.inviteCodeRequired ||
      config.invites ||
      (await db.list("entryway:invites")).length
        ? `<label for="inviteCode">Invite code${config.inviteCodeRequired ? "" : " (optional)"}</label><input id="inviteCode" name="inviteCode" value="${escapeHtml(reservedInvite ?? "")}" ${config.inviteCodeRequired ? "required" : ""} ${reservedInvite ? "readonly" : ""}>`
        : "";
    const pdsOptions = config.pds
      .map((p) => {
        const selected = retry && p.id === pending.pdsId ? " selected" : "";
        return `<option value="${escapeHtml(p.id)}"${selected}>${escapeHtml(p.id)} — ${escapeHtml(p.url)}</option>`;
      })
      .join("");
    const { intro, button } = signupState(recoveryRequired, retry);
    return `<p>${intro}</p><form method="post" action="/auth/account">${fields(flow, browser)}<label for="handle">Handle</label><input id="handle" name="handle" placeholder="${escapeHtml(config.publicHandles?.[0] ?? "alice.entryway.test")}" value="${escapeHtml(initialHandle)}" ${retry || hintedHandle ? "readonly" : ""} ${config.publicHandles ? 'list="public-handles"' : ""} required>${suggestions}<small>${handleHelp}</small><label for="pdsId">Personal data server</label><select id="pdsId" name="pdsId" ${retry ? "disabled" : ""}>${pdsOptions}</select>${inviteInput}<button ${recoveryRequired ? "disabled" : ""}>${button}</button></form>`;
  };
  return signupForm;
}
