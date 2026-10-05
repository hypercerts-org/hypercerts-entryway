import * as plc from "@did-plc/lib";

import { fail } from "../accounts/input.mjs";
import { xrpc } from "../pds/client.mjs";

export async function createPlcOperations({
  db,
  config,
  accounts,
  sendCode,
  requireCode,
  pdsCall,
  choosePds,
}) {
  const reserveSigningKey = async ({ did, pdsId } = {}) => {
    const existing = did && accounts.get(did);
    const pds = existing ? accounts.pdsFor(existing) : choosePds(pdsId);
    return xrpc(
      pds.internalUrl,
      "com.atproto.server.reserveSigningKey",
      did ? { did } : {},
    );
  };
  const requestPlcOperationSignature = (row) => {
    accounts.assertNoMigration?.(row.did);
    return sendCode(
      "plc-operation",
      `${row.did}:${row.email}`,
      row.email,
      "email",
      row.did,
    );
  };
  const signPlcOperation = async (row, body) => {
    accounts.assertNoMigration?.(row.did);
    const current = await accounts.plcClient.getLastOp(row.did);
    if (current.type === "plc_tombstone")
      fail("InvalidRequest", "The identity is tombstoned");
    const allowed = [
      "token",
      "rotationKeys",
      "alsoKnownAs",
      "verificationMethods",
      "services",
    ];
    if (Object.keys(body).some((k) => !allowed.includes(k)))
      fail("InvalidRequest", "Unknown operation field");
    let operation;
    try {
      operation = await plc.createUpdateOp(
        current,
        accounts.rotation,
        (op) => ({
          ...op,
          ...Object.fromEntries(
            allowed
              .filter((k) => k !== "token" && body[k] !== undefined)
              .map((k) => [k, body[k]]),
          ),
        }),
      );
      plc.def.operation.parse(operation);
      await plc.assureValidOp(operation);
      if (
        !operation.verificationMethods.atproto ||
        operation.services.atproto_pds?.type !== "AtprotoPersonalDataServer"
      )
        throw new Error("Missing AT Protocol identity fields");
      const endpoint = new URL(operation.services.atproto_pds.endpoint);
      if (
        endpoint.protocol !== "https:" ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash ||
        endpoint.search
      )
        throw new Error("Invalid PDS URL");
      if (!operation.alsoKnownAs.some((a) => a.startsWith("at://")))
        throw new Error("Missing handle");
      await plc.assureValidSig(
        plc.normalizeOp(current).rotationKeys,
        operation,
      );
    } catch {
      fail(
        "InvalidPlcOperation",
        "The requested identity operation is invalid or this entryway no longer has signing authority",
      );
    }
    // Validate first; the purpose-bound email proof is consumed exactly once before
    // returning a signature. A signature for migration can transfer all authority.
    const currentAccount = accounts.get(row.did);
    if (
      !currentAccount ||
      currentAccount.did !== row.did ||
      currentAccount.email !== row.email ||
      ["deleted", "provisioning"].includes(currentAccount.status)
    )
      fail(
        "InvalidToken",
        "Account authority changed; request a new signature code",
      );
    accounts.assertNoMigration?.(row.did);
    requireCode("plc-operation", `${row.did}:${row.email}`, body.token);
    db.set("events", `plc:${crypto.randomUUID()}`, {
      type: "plc.signed",
      did: row.did,
      prev: operation.prev,
      at: new Date(),
    });
    return { operation };
  };
  const submitPlcOperation = async (row, { operation }) => {
    accounts.assertNoMigration?.(row.did);
    // The hosting PDS enforces its own key/handle/endpoint invariants and sequences
    // identity events. A migration-away operation is signed here and submitted to
    // the directory by its owner, rather than weakening the stock PDS constraints.
    await pdsCall(row, "com.atproto.identity.submitPlcOperation", {
      operation,
    });
    return {};
  };
  return {
    reserveSigningKey,
    requestPlcOperationSignature,
    signPlcOperation,
    submitPlcOperation,
  };
}
