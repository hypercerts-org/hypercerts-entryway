import { createOperationOwnership } from "./accounts/operation-ownership.js";
import { createAccountAccess } from "./accounts/account-access.mjs";
import { createOperationOwnershipStore } from "./database/drizzle/operation-ownership.js";
import { createAccountAuthority } from "./database/drizzle/account-authority.mjs";
import { createEmailAuthorityChange } from "./accounts/change-email-authority.mjs";
import { createSecurityPrimitives } from "./accounts/security-primitives.mjs";
import { createAccountSettingsSecurity } from "./features/account-settings/security.mjs";
import { createAccountRecovery } from "./features/account-recovery/recover-account.mjs";
import { createDeletionAuthorization } from "./features/account-deletion/authorize-deletion.mjs";
import { createMigrationProof } from "./features/pds-migration/proof.mjs";

export async function createAccountSecurity(dependencies) {
  const authority = createAccountAuthority(dependencies);
  const accountAccess =
    dependencies.accountAccess ??
    createAccountAccess(dependencies.accounts.storage);
  await authority.initializeClaims();
  const ownership =
    dependencies.accounts.ownership ??
    createOperationOwnership({
      store: createOperationOwnershipStore(dependencies.db),
    });
  const proofs = createSecurityPrimitives({
    ...dependencies,
    authority,
    ownership,
  });
  const changeEmailAuthority = createEmailAuthorityChange({
    ...dependencies,
    authority,
    proofs,
    ownership,
  });
  const context = {
    ...dependencies,
    accountAccess,
    authority,
    proofs,
    changeEmailAuthority,
  };
  const security = {
    assertEmailAvailable: proofs.assertEmailAvailable,
    bindVerifiedIdentity: proofs.bindVerifiedIdentity,
    revokeAccount: proofs.revokeAccount,
    isRecent: proofs.isRecent,
    beginReconfirm: proofs.beginReconfirm,
    resendReconfirm: proofs.resendReconfirm,
    completeReconfirm: proofs.completeReconfirm,
    ...createAccountSettingsSecurity(context),
    ...createAccountRecovery(context),
    ...createDeletionAuthorization(context),
    ...createMigrationProof(context),
  };
  dependencies.oauth.setAccountSecurity?.(security);
  return security;
}
