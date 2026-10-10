import { createOperationOwnership } from "./accounts/operation-ownership.js";
import { createOperationOwnershipStore } from "./database/drizzle/operation-ownership.js";
import * as plc from "@did-plc/lib";
import { genesisRotationKeys } from "./plc/policy.js";
import { readCustodyObservation } from "./plc/observations.js";
import { createCustodyInventoryStorage } from "./database/drizzle/migration-custody.js";
import { Secp256k1MigrationPlcSigner } from "./plc/signing.js";
import { createAccountStorage } from "./database/drizzle/account-storage.js";
import { createAccountPrimitives } from "./accounts/primitives.mjs";
import { createRegistration } from "./features/account-registration/create-account.js";
import { createHandleChange } from "./features/handle-change/change-handle.js";
import { createStatusChange } from "./features/account-settings/change-status.mjs";
import { createDeletion } from "./features/account-deletion/delete-account.mjs";
import { createAccountReconciler } from "./reconcile-accounts.mjs";

// Composition only: each operation and its mutable state live with its feature.
export async function createAccounts({
  db,
  config,
  workerId,
  ownership = createOperationOwnership({
    store: createOperationOwnershipStore(db),
    workerId,
  }),
}) {
  const plcSigner = await Secp256k1MigrationPlcSigner.fromHex(
    config.plcRotationKeyHex,
  );
  genesisRotationKeys({
    offline: config.plcRecoveryKeyDid,
    hot: plcSigner.publicKey(),
  });
  if (
    config.plcRotationKeyDid &&
    config.plcRotationKeyDid !== plcSigner.publicKey()
  )
    throw Object.assign(
      new Error("PLC public configuration does not match the signer"),
      { code: "InvalidPlcConfiguration" },
    );
  const plcClient = new plc.Client(config.plcUrl);
  const storage = createAccountStorage(db, config.pds);
  const custody = createCustodyInventoryStorage(db);
  const shared = createAccountPrimitives({ db, config, storage, ownership });
  const observeCustody = async (did) => {
    const observation = await readCustodyObservation(
      plcClient,
      did,
      ownership.currentClaim.operationId,
    );
    await db.transact(async () => {
      await custody.recordObservation(observation);
      await db.delete("custody:refresh-pending", did);
    });
    return observation;
  };
  const context = {
    db,
    config,
    plcSigner,
    plcClient,
    observeCustody,
    custody,
    ...shared,
  };
  const registration = createRegistration(context);
  const operations = {
    ...registration,
    updateHandle: createHandleChange(context),
    setStatus: createStatusChange(context),
    ...createDeletion(context),
  };
  const refreshCustodyObservation = (did) =>
    shared.serialized(did, () => observeCustody(did), {
      kind: "custody-observe",
      request: {},
    });
  return {
    ...shared,
    ...operations,
    plcSigner,
    plcClient,
    observeCustody,
    custody,
    // Internal operator harness only. Observation never settles pending dispatch
    // and admission rejects a conflicting operation, including uncertain writes.
    refreshCustodyObservation,
    reconcile: createAccountReconciler({
      db,
      ...shared,
      ...operations,
      refreshCustodyObservation,
    }),
  };
}
