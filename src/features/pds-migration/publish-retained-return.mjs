import { cidForCbor } from "@atproto/common";
import * as plc from "@did-plc/lib";
import {
  noExternalResult,
  requestDigest,
} from "../../accounts/operation-ownership.js";
import { HttpError } from "../../http/http-error.mjs";

/** Publish a previously journaled return operation under the migration claim.
 * The caller must first verify the inactive target's imported snapshot and the
 * frozen source; this function does not establish those remote preconditions.
 */
export async function publishRetainedReturn({
  db,
  ownership,
  transfers,
  plcClient,
  plcUrl,
  operation,
  verifyPrepublication,
}) {
  const claim = ownership.currentClaim;
  const saved = await db.get("migration:history", operation.id);
  const current = await db.get(
    "migration:operations",
    `migrate:${operation.did}`,
  );
  if (
    !claim ||
    claim.resource !== operation.did ||
    claim.kind !== "managed-migration" ||
    !saved ||
    saved.id !== operation.id ||
    saved.did !== operation.did ||
    saved.authorityOperationId !== claim.operationId ||
    current?.id !== saved.id ||
    current?.did !== saved.did ||
    current?.plcOpCid !== saved.plcOpCid ||
    current?.authorityOperationId !== claim.operationId ||
    !(await transfers.isOwner({
      did: saved.did,
      operationId: saved.id,
      transferKind: "managed",
    })) ||
    !saved.returnIntent ||
    !saved.plcOp ||
    !saved.plcOpCid ||
    !saved.plcOp.prev ||
    String(await cidForCbor(saved.plcOp)) !== saved.plcOpCid ||
    saved.plcOpCid !== operation.plcOpCid
  )
    throw new HttpError(
      409,
      "OperationRecoveryRequired",
      "The exact signed return intent is not journaled",
    );
  const savedDigest = requestDigest(saved);
  const currentDigest = requestDigest(current);
  const requireOwnership = async () => {
    const history = await db.get("migration:history", saved.id);
    const journal = await db.get(
      "migration:operations",
      `migrate:${saved.did}`,
    );
    if (
      !history ||
      !journal ||
      requestDigest(history) !== savedDigest ||
      requestDigest(journal) !== currentDigest ||
      !(await transfers.isOwner({
        did: saved.did,
        operationId: saved.id,
        transferKind: "managed",
      }))
    )
      throw new HttpError(
        409,
        "OperationRecoveryRequired",
        "The return publication ownership or journal changed",
      );
    await ownership.assertActive();
  };
  const signed = saved.plcOp;
  await plc.assureValidOp(signed);
  const head = async () =>
    String(await cidForCbor(await plcClient.getLastOp(saved.did)));
  const requirePredecessor = async () => {
    const previous = await plcClient.getLastOp(saved.did);
    if (
      String(await cidForCbor(previous)) !== signed.prev ||
      previous.type === "plc_tombstone"
    )
      throw new HttpError(
        409,
        "IdentityChanged",
        "PLC changed before return publication",
      );
    const normalized = plc.normalizeOp(previous);
    await plc.assureValidSig(normalized.rotationKeys, signed);
    const { sig: _signature, ...unsigned } = signed;
    const { sig: _previousSignature, ...facts } = normalized;
    const expected = {
      ...facts,
      prev: signed.prev,
      verificationMethods: {
        ...facts.verificationMethods,
        atproto: saved.returnIntent.signingKey,
      },
      services: {
        ...facts.services,
        atproto_pds: {
          type: "AtprotoPersonalDataServer",
          endpoint: saved.targetPlcEndpoint ?? saved.returnIntent.targetPdsUrl,
        },
      },
    };
    if (
      String(await cidForCbor(unsigned)) !== String(await cidForCbor(expected))
    )
      throw new HttpError(
        409,
        "InvalidPlcOperation",
        "Signed return does not preserve the expected PLC authority",
      );
  };
  await ownership.dispatch(
    {
      step: `publish-retained-return:${saved.plcOpCid}`,
      target: plcUrl,
      method: "plc.sendOperation",
      intent: { did: saved.did, operation: signed },
      beforeFirst: async () => {
        await verifyPrepublication?.();
        await requirePredecessor();
      },
    },
    {
      ...noExternalResult,
      send: async () => {
        // Recheck after the durable dispatch marker; a failure is uncertain and
        // needs the same operator isolation and observation as a lost response.
        await verifyPrepublication?.();
        await requirePredecessor();
        // Local checks cannot atomically fence a remote PLC dispatch.
        await requireOwnership();
        await plcClient.sendOperation(saved.did, signed);
        await requireOwnership();
      },
      observe: async () => {
        const current = await head();
        await requireOwnership();
        return {
          state:
            current === saved.plcOpCid
              ? "applied"
              : current === signed.prev
                ? "unapplied"
                : "diverged",
          result: undefined,
        };
      },
    },
  );
  const canonicalHead = await head();
  await requireOwnership();
  if (canonicalHead !== saved.plcOpCid)
    throw new HttpError(
      409,
      "IdentityChanged",
      "Published return is not the canonical PLC head",
    );
}
