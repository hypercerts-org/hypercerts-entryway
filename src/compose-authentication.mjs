import { createBetterAuthAuthentication } from "./authentication/better-auth.mjs";
import { createBrowserFlow } from "./http/browser-flow.mjs";
import { page, escapeHtml } from "./ui/html.mjs";
import { createLoginForms } from "./features/email-login/page.mjs";
import { mountEmailLogin } from "./features/email-login/routes.mjs";
import { createSignupForm } from "./features/account-registration/page.mjs";
import { mountSignupRoutes } from "./features/account-registration/signup-routes.mjs";
import { createConsent } from "./features/oauth-authorization/consent.mjs";
import { mountAuthorizationRoutes } from "./features/oauth-authorization/authorization-routes.mjs";
import { authorizationRedirect } from "./features/oauth-authorization/redirect.mjs";
import { accountEmailSchema } from "./accounts/input-schema.js";

export async function createAuthentication({
  app,
  db,
  config,
  accounts,
  accountAccess,
  provider,
  stores,
  mail,
  clientRequestsSignupConsentSkip,
}) {
  let accountSecurity;
  const getAccountSecurity = () => accountSecurity;
  const authentication = await createBetterAuthAuthentication({
    db,
    config,
    mail,
  });
  const flows = createBrowserFlow({
    db,
    config,
    provider,
    redirectAuthorizationError: (res, error) =>
      authorizationRedirect(
        res,
        config.issuer,
        error.parameters,
        error.toJSON(),
      ),
  });
  const forms = createLoginForms(flows);
  const signupForm = createSignupForm({
    db,
    config,
    accounts,
    fields: flows.fields,
  });
  const { consentForm, authenticated } = createConsent({
    db,
    config,
    provider,
    stores,
    flows,
    accountAccess,
    clientRequestsSignupConsentSkip,
  });
  const { startEmailCode } = mountEmailLogin({
    app,
    db,
    authentication,
    mail,
    flows,
    forms,
    signupForm,
    authenticated,
    getAccountSecurity,
    async forgetBrowserAccounts(deviceId) {
      for (const entry of await provider.accountManager.listDeviceAccounts(
        deviceId,
      )) {
        await provider.accountManager.removeDeviceAccount(
          deviceId,
          entry.account.did,
        );
      }
    },
  });
  mountSignupRoutes({
    app,
    db,
    accounts,
    accountAccess,
    authentication,
    flows,
    signupForm,
    authenticated,
    handleDomain: config.publicHandles ? undefined : config.handleDomains?.[0],
  });
  // The account a handle or DID names, when it can be sent a code: active and
  // with an email the code form would accept. The address stays out of the
  // browser until the code page masks it.
  const hintedAccount = async (hint) => {
    const row = await accounts.get(hint);
    return row?.status === "active" &&
      accountEmailSchema.safeParse(row.email).success
      ? { did: row.did, email: row.email }
      : null;
  };
  mountAuthorizationRoutes({
    app,
    db,
    config,
    provider,
    flows,
    loginForm: forms.loginForm,
    consentForm,
    startEmailCode,
    hintedAccount,
  });
  return {
    ...authentication,
    loadBrowser: flows.loadBrowser,
    checkCsrf: flows.checkCsrf,
    page,
    escapeHtml,
    setAccountSecurity(service) {
      accountSecurity = service;
    },
  };
}
