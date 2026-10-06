import { createOperationOwnership } from "./accounts/operation-ownership.js";
import { createOperationOwnershipStore } from "./database/drizzle/operation-ownership.js";
import * as plc from "@did-plc/lib";
import { Secp256k1Keypair } from "@atproto/crypto";
import { createAccountStorage } from "./database/drizzle/account-storage.js";
import { createAccountPrimitives } from "./accounts/primitives.mjs";
import { createRegistration } from "./features/account-registration/create-account.mjs";
import { createHandleChange } from "./features/handle-change/change-handle.mjs";
import { createStatusChange } from "./features/account-settings/change-status.mjs";
import { createDeletion } from "./features/account-deletion/delete-account.mjs";
import { createAccountReconciler } from "./reconcile-accounts.mjs";

// Composition only: each operation and its mutable state live with its feature.
export async function createAccounts({
  db,
  config,
  ownership = createOperationOwnership({
    store: createOperationOwnershipStore(db),
  }),
}) {
  const rotation = await Secp256k1Keypair.import(
    Buffer.from(config.plcRotationKeyHex, "hex"),
  );
  const plcClient = new plc.Client(config.plcUrl);
  const storage = createAccountStorage(db, config.pds);
  const shared = createAccountPrimitives({ db, config, storage, ownership });
  const context = { db, config, rotation, plcClient, ...shared };
  const registration = createRegistration(context);
  const operations = {
    ...registration,
    updateHandle: createHandleChange(context),
    setStatus: createStatusChange(context),
    ...createDeletion(context),
  };
  return {
    ...shared,
    ...operations,
    rotation,
    plcClient,
    reconcile: createAccountReconciler({ db, ...shared, ...operations }),
  };
}
