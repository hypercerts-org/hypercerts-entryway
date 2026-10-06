import { signingKeyResult } from "../accounts/operation-ownership.js";
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
    const existing = did && (await accounts.get(did));
    const pds = existing ? accounts.pdsFor(existing) : choosePds(pdsId);
    const send = () =>
      xrpc(
        pds.internalUrl,
        "com.atproto.server.reserveSigningKey",
        did ? { did } : {},
      );
    // Without a DID this only allocates an unbound repository key. It cannot
    // change an account, publish PLC or conflict with an admitted DID operation.
    if (!did) return send();
    return accounts.ownership.dispatch(
      {
        step: "reserve-signing-key",
        target: pds.url ?? pds.internalUrl,
        method: "com.atproto.server.reserveSigningKey",
        intent: { did },
      },
      {
        ...signingKeyResult,
        send,
        observe: async () => ({ state: "replay-safe" }),
      },
    );
  };
  const requestPlcOperationSignature = async (row) => {
    await accounts.assertNoMigration?.(row.did);
    return await sendCode(
      "plc-operation",
      `${row.did}:${row.email}`,
      row.email,
      "email",
      row.did,
    );
  };
  const signPlcOperation = async (row, body) => {
    await accounts.assertNoMigration?.(row.did);
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
    const currentAccount = await accounts.get(row.did);
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
    await accounts.assertNoMigration?.(row.did);
    await requireCode("plc-operation", `${row.did}:${row.email}`, body.token);
    await db.set("events", `plc:${crypto.randomUUID()}`, {
      type: "plc.signed",
      did: row.did,
      prev: operation.prev,
      at: new Date(),
    });
    return { operation };
  };
  const submitPlcOperation = async (row, { operation }) => {
    await accounts.assertNoMigration?.(row.did);
    // The hosting PDS enforces its own key/handle/endpoint invariants and sequences
    // identity events. A migration-away operation is signed here and submitted to
    // the directory by its owner, rather than weakening the stock PDS constraints.
    await pdsCall(row, "com.atproto.identity.submitPlcOperation", {
      operation,
    });
    return {};
  };
  const serialize = (did, kind, request, perform) =>
    accounts.serialized(did, perform, { kind, request });
  return {
    reserveSigningKey: (input = {}) =>
      input.did
        ? serialize(
            input.did,
            "plc-reserve",
            { pdsId: input.pdsId ?? null },
            () => reserveSigningKey(input),
          )
        : reserveSigningKey(input),
    requestPlcOperationSignature: (row) =>
      serialize(row.did, "plc-proof", {}, () =>
        requestPlcOperationSignature(row),
      ),
    signPlcOperation: (row, body) => {
      const { token: _proof, ...publicIntent } = body;
      // This admission ends after returning the signature. The owner may publish
      // it independently later; Entryway cannot serialize third-party publication.
      return serialize(row.did, "plc-sign", publicIntent, () =>
        signPlcOperation(row, body),
      );
    },
    submitPlcOperation: (row, { operation }) =>
      serialize(row.did, "plc-submit", { operation }, () =>
        submitPlcOperation(row, { operation }),
      ),
  };
}
