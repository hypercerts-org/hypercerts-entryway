import { cidForCbor } from "@atproto/common";
import * as plc from "@did-plc/lib";
import {
  validateAuditObservation,
  readCustodyObservation,
} from "./observations.js";

/** Publication evidence is derived exclusively from validated configured history. */
export async function observeIncomingHandoff(
  client: plc.Client,
  did: string,
  cid: string,
  predecessor: string,
) {
  const observation = await readCustodyObservation(client, did);
  const current = await client.getLastOp(did);
  if (String(await cidForCbor(current)) !== observation.snapshot.headCid)
    throw new PlcError(
      "InvalidCustodyObservation",
      "Directory head changed during observation",
    );
  return {
    canonical:
      !observation.snapshot.tombstone && observation.snapshot.headCid === cid,
    diverged:
      observation.snapshot.tombstone ||
      ![cid, predecessor].includes(observation.snapshot.headCid),
    tombstone: observation.snapshot.tombstone,
  };
}
import { PlcError } from "./errors.js";
import { sameSignedOperation, validateUnsignedOperation } from "./policy.js";

/** For incoming-migration orchestration: retain the signed predecessor, not the
 * unsigned custody projection. History establishes identity state, not ownership. */
export async function readIncomingObservation(client: plc.Client, did: string) {
  const audit = await client.getAuditableLog(did);
  const observation = await validateAuditObservation(
    did,
    audit,
    null,
    client.url,
  );
  const head = audit.filter((entry) => !entry.nullified).at(-1);
  const current = await client.getLastOp(did);
  if (
    !head ||
    observation.snapshot.tombstone ||
    head.operation.type === "plc_tombstone" ||
    String(await cidForCbor(current)) !== observation.snapshot.headCid
  )
    throw new PlcError(
      "InvalidCustodyObservation",
      "The incoming identity head changed or is unavailable",
    );
  const parsed = plc.def.compatibleOp.parse(head.operation);
  if (!sameSignedOperation(parsed, head.operation))
    throw new PlcError(
      "InvalidCustodyObservation",
      "Unexpected signed operation fields",
    );
  const predecessor = structuredClone(head.operation);
  const { sig: _signature, ...unsigned } = plc.normalizeOp(predecessor);
  const facts = validateUnsignedOperation(unsigned);
  return {
    sourcePredecessor: predecessor,
    sourcePlcHead: head.cid,
    rotationKeys: facts.rotationKeys,
    source: {
      services: facts.services,
      verificationMethods: facts.verificationMethods,
      alsoKnownAs: facts.alsoKnownAs,
    },
  };
}
