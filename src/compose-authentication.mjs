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

export async function createAuthentication({
  app,
  db,
  config,
  accounts,
  provider,
  stores,
  mail,
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
    provider,
    stores,
    flows,
  });
  mountEmailLogin({
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
    authentication,
    flows,
    signupForm,
    authenticated,
    getAccountSecurity,
  });
  mountAuthorizationRoutes({
    app,
    db,
    config,
    provider,
    flows,
    loginForm: forms.loginForm,
    consentForm,
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
