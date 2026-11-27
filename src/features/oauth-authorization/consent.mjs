import {
  AccountPermission,
  BlobPermission,
  IdentityPermission,
  RepoPermission,
  RpcPermission,
} from "@atproto/oauth-scopes";
import { approvalVersion } from "../../database/oauth-approval.mjs";
import { InvalidRequestError } from "@atproto/oauth-provider/errors";
import { escapeHtml } from "../../ui/html.mjs";
import { renderConsent } from "#entryway-ssr/oauth-authorization";
import { matchesAuthorizationHint } from "../../accounts/rules.js";
import {
  completeAuthorization,
  GrantNoLongerApprovedError,
} from "./complete-authorization.mjs";
import { pendingArrivalMessage } from "../../accounts/pending-arrival.js";
export function createConsent({
  db,
  config,
  provider,
  stores,
  flows,
  accountAccess,
  pendingArrival,
  clientRequestsSignupConsentSkip,
}) {
  const { save, readCurrentIntent, pageForFlow } = flows;
  const describeScope = (value) => {
    if (value === "atproto") return "Sign in with your AT Protocol account.";
    if (value === "transition:generic")
      return "Create, update, and delete any repository records, upload media, read and change preferences, and use most services except chat. This does not include account management.";
    if (value === "transition:email") return "Read your account email address.";
    if (value === "transition:chat.bsky")
      return "Call chat.bsky service methods.";
    const repo = RepoPermission.fromString(value);
    if (repo)
      return `Permitted record actions: ${repo.action.join(", ")} in ${repo.collection.join(", ")}.`;
    const rpc = RpcPermission.fromString(value);
    if (rpc) return `Call ${rpc.lxm.join(", ")} on ${rpc.aud}.`;
    const account = AccountPermission.fromString(value);
    if (account)
      return `${account.action.join(" and ")} account ${account.attr}.`;
    const identity = IdentityPermission.fromString(value);
    if (identity) return `Change identity ${identity.attr}.`;
    const blob = BlobPermission.fromString(value);
    if (blob) return `Upload media with types ${blob.accept.join(", ")}.`;
    return "Review the exact permission requested below.";
  };
  const scopeGroups = (scope) => {
    const groups = new Map();
    const labels = {
      atproto: "AT Protocol account access",
      account: "Account data permissions",
      blob: "Blob permissions",
      identity: "Identity permissions",
      include: "Included permission sets",
      repo: "Repository permissions",
      rpc: "Service permissions",
      transition: "Legacy permissions",
    };
    for (const value of (scope ?? "").split(" ").filter(Boolean)) {
      const label = labels[value.split(":", 1)[0]] ?? "Requested permissions";
      const values = groups.get(label) ?? [];
      if (!values.some((item) => item.value === value))
        values.push({ value, description: describeScope(value) });
      groups.set(label, values);
    }
    return [...groups].map(([label, values]) => ({ label, values }));
  };
  const consentForm = (flow, browser, account) =>
    renderConsent({
      flow: flow.id,
      csrf: browser.csrf,
      did: account.did,
      handle: account.handle ?? account.did,
      clientName: flow.clientName?.trim() || flow.clientId,
      scopes: scopeGroups(flow.parameters?.scope),
      canChoose: Boolean(flow.authUserId && flow.authBindings > 1),
    }).body;
  // Loads what completeAuthorization needs, then lets the caller's policy decide
  // whether this sign-in may issue the code without showing consent. Every
  // lookup that precedes issuing the code is inside the try, so any failure
  // shows consent. getDeviceAccount throws for a missing device account, so
  // that case is covered too.
  const consentSkip = async (flow, browser, did, mayConsentBeSkipped) => {
    try {
      const version = await approvalVersion(db, did, flow.clientId);
      const client = await provider.clientManager.getClient(flow.clientId);
      const request = await flows.request(flow, browser);
      const deviceAccount = await provider.accountManager.getDeviceAccount(
        browser.deviceId,
        did,
      );
      if (!deviceAccount) return null;
      const skip = { client, request, deviceAccount, version };
      return (await mayConsentBeSkipped(skip)) ? skip : null;
    } catch {
      return null;
    }
  };
  // ePDS parity: a brand-new account skips consent only when the client is on
  // the Entryway trusted list and the client's metadata opts in with epds_skip_consent_on_signup. As in ePDS, a
  // prompt=consent request does not override that opt-in.
  const signupConsentSkip = (flow, browser, did) =>
    consentSkip(
      flow,
      browser,
      did,
      async ({ client }) =>
        client.isTrusted === true &&
        (await clientRequestsSignupConsentSkip(flow.clientId)) === true,
    );
  // The email hint's sign-on without a code skips consent when the stock
  // provider policy says this client already holds every requested scope. That policy also keeps
  // prompt=consent and new scopes on the consent page. An untrusted public
  // client never skips: the request manager already stores prompt=consent for
  // it, but Entryway does not rely on that rewrite staying in the provider.
  const priorGrantApproves = ({ client, request }, grant) =>
    (client.isConfidential || client.isTrusted) &&
    !provider.checkConsentRequired(request.parameters, grant);
  // The grant read here may be revoked before completeAuthorization commits, so
  // completion reruns the same policy on the grant it reads in its transaction.
  // A sign-in that showed Entryway's own pages (code, chooser) always shows
  // consent instead, as a stock PDS does after its sign-in page.
  const priorConsentSkip = async (flow, browser, did) => {
    const skip = await consentSkip(flow, browser, did, (found) =>
      priorGrantApproves(
        found,
        found.deviceAccount.authorizedClients.get(found.client.id),
      ),
    );
    return (
      skip && {
        ...skip,
        stillApproved: (grant) => priorGrantApproves(skip, grant),
      }
    );
  };
  const authenticated = async (
    req,
    res,
    flow,
    browser,
    row,
    {
      identity,
      commitCookies = () => {},
      fromChooser = false,
      newAccount = false,
      // How many accounts the verified identity is bound to (0 when the caller
      // does not know), so the consent page knows whether another choice
      // exists.
      bindingCount = 0,
    } = {},
  ) => {
    const displayAccount =
      row.status === "active" && flow.requestUri
        ? await stores.account(row.did)
        : null;
    const authorized = await db.transact(async () => {
      const current = await readCurrentIntent(flow, browser);
      if (
        fromChooser &&
        (current.authEmail !== identity.email.toLowerCase() ||
          current.authUserId !== identity.userId)
      )
        throw new InvalidRequestError("This account choice is no longer valid");
      const account = await accountAccess.requireBoundAccount(
        identity,
        row.did,
      );
      if (
        !matchesAuthorizationHint(
          account,
          current.accountHint,
          current.parameters?.login_hint,
        )
      )
        throw new InvalidRequestError(
          "Sign in to the account requested by this application",
        );
      current.authEmail = identity.email.toLowerCase();
      // Record the verified identity with the binding, so reopening the
      // authorization URL resumes at this consent form instead of asking for
      // another code.
      current.authUserId = identity.userId;
      // The caller supplies the identity's current binding count whenever it
      // knows it, so a binding lost between chooser and selection also
      // lowers the recorded count here.
      if (bindingCount) current.authBindings = bindingCount;
      // The latest choice wins. An unavailable account still replaces the
      // earlier selection, so that account's consent form no longer matches.
      current.authDid = account.status === "active" ? account.did : undefined;
      // Inactive accounts still record this browser's fresh sign-in: the
      // account console requires it, and it is the only place to reactivate
      // or settle a migration. Authorization choosers skip deactivated
      // device accounts, so this does not make the account usable for OAuth.
      if (account.status !== "deleted")
        await provider.accountManager.upsertDeviceAccount(
          browser.deviceId,
          account.did,
        );
      if (account.status === "active" && !current.requestUri)
        await db.delete("auth-flows", current.id);
      else await save(current);
      return { current, account };
    });
    // Deleted accounts cannot be restored, so verification must not leave a
    // browser session or point the user at reactivation.
    if (authorized.account.status === "deleted")
      return pageForFlow(
        res,
        "Account unavailable",
        "<p>This account is deleted and cannot be used to sign in.</p>",
        authorized.current,
        403,
      );
    commitCookies();
    // Deny by default: a pending incoming arrival never authorizes an
    // application and is never offered reactivation.
    if (await pendingArrival.isPending(authorized.account))
      return pageForFlow(
        res,
        "Migration in progress",
        `<p role="status">${escapeHtml(pendingArrivalMessage)}</p><p><a href="/incoming">Review your incoming migration</a></p>`,
        authorized.current,
        409,
      );
    if (authorized.account.status !== "active")
      return pageForFlow(
        res,
        "Account unavailable",
        `<p>This account is deactivated. <a href="/account?did=${encodeURIComponent(authorized.account.did)}">Open account settings</a> to reactivate it.</p>`,
        authorized.current,
        403,
      );
    if (!authorized.current.requestUri)
      return res.redirect(
        303,
        `/account?did=${encodeURIComponent(authorized.account.did)}`,
      );
    const skip = newAccount
      ? await signupConsentSkip(
          authorized.current,
          browser,
          authorized.account.did,
        )
      : null;
    if (skip) {
      try {
        return await completeAuthorization({
          db,
          config,
          provider,
          refreshFlow: flows.refreshFlow,
          runRequest: flows.runRequest,
          res,
          flow: authorized.current,
          browser,
          ...skip,
        });
      } catch (error) {
        if (!(error instanceof GrantNoLongerApprovedError)) throw error;
      }
    }
    return pageForFlow(
      res,
      "Authorize application",
      consentForm(
        authorized.current,
        browser,
        displayAccount ?? authorized.account,
      ),
      authorized.current,
    );
  };
  return { consentForm, authenticated, priorConsentSkip };
}
