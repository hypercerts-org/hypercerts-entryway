import { createProtocolRouting } from "./http/protocol-authentication.mjs";
import { mountHttpXrpc } from "./http/xrpc-routes.mjs";
import { mountHandleChangeXrpc } from "./features/handle-change/xrpc-routes.mjs";
import { mountEmailLoginXrpc } from "./features/email-login/xrpc-routes.mjs";
import { mountAccountRegistrationXrpc } from "./features/account-registration/xrpc-routes.mjs";
import { mountPdsMigrationXrpc } from "./features/pds-migration/xrpc-routes.mjs";
import { mountConnectedAppsXrpc } from "./features/connected-apps/xrpc-routes.mjs";
import { mountAccountSettingsXrpc } from "./features/account-settings/xrpc-routes.mjs";
import { mountAccountRecoveryXrpc } from "./features/account-recovery/xrpc-routes.mjs";
import { mountAccountDeletionXrpc } from "./features/account-deletion/xrpc-routes.mjs";
import { mountPlcXrpc } from "./plc/xrpc-routes.mjs";
import { mountOauthAuthorizationXrpc } from "./features/oauth-authorization/xrpc-routes.mjs";
import { mountMailXrpc } from "./mail/xrpc-routes.mjs";

export async function mountXrpc(services) {
  const routing = await createProtocolRouting(services);
  mountHttpXrpc({ ...services, ...routing });
  mountHandleChangeXrpc({ ...services, ...routing });
  mountEmailLoginXrpc({ ...services, ...routing });
  mountAccountRegistrationXrpc({ ...services, ...routing });
  mountPdsMigrationXrpc({ ...services, ...routing });
  mountConnectedAppsXrpc({ ...services, ...routing });
  mountAccountSettingsXrpc({ ...services, ...routing });
  mountAccountRecoveryXrpc({ ...services, ...routing });
  mountAccountDeletionXrpc({ ...services, ...routing });
  mountPlcXrpc({ ...services, ...routing });
  mountOauthAuthorizationXrpc({ ...services, ...routing });
  mountMailXrpc({ ...services, ...routing });
  return { authenticate: routing.authenticate };
}
