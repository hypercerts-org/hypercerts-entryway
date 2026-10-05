import { createAccountAuthority } from "./database/sqlite/account-authority.mjs";
import { createEmailAuthorityChange } from "./accounts/change-email-authority.mjs";
import { createSecurityPrimitives } from "./accounts/security-primitives.mjs";
import { createAccountSettingsSecurity } from "./features/account-settings/security.mjs";
import { createAccountRecovery } from "./features/account-recovery/recover-account.mjs";
import { createDeletionAuthorization } from "./features/account-deletion/authorize-deletion.mjs";
import { createMigrationProof } from "./features/pds-migration/proof.mjs";

export async function createAccountSecurity(dependencies) {
  const authority = createAccountAuthority(dependencies);
  authority.initializeClaims();
  const proofs = createSecurityPrimitives({ ...dependencies, authority });
  const changeEmailAuthority = createEmailAuthorityChange({
    ...dependencies,
    authority,
    proofs,
  });
  const context = { ...dependencies, authority, proofs, changeEmailAuthority };
  const security = {
    assertEmailAvailable: proofs.assertEmailAvailable,
    bindVerifiedIdentity: proofs.bindVerifiedIdentity,
    revokeAccount: proofs.revokeAccount,
    ...createAccountSettingsSecurity(context),
    ...createAccountRecovery(context),
    ...createDeletionAuthorization(context),
    ...createMigrationProof(context),
  };
  dependencies.oauth.setAccountSecurity?.(security);
  return security;
}
