import { cidForCbor } from "@atproto/common";
import { Secp256k1Keypair } from "@atproto/crypto";
import { createAccounts } from "../../dist/src/compose-accounts.mjs";
import { openTestDatabase } from "./database-fixture.mjs";

export async function fixture(
  t,
  reply,
  { path = ":memory:", ownershipFactory } = {},
) {
  const rotation = await Secp256k1Keypair.create({ exportable: true });
  const offline = await Secp256k1Keypair.create();
  const config = {
    plcRecoveryKeyDid: offline.did(),
    plcRotationKeyHex: Buffer.from(await rotation.export()).toString("hex"),
    plcUrl: "https://plc.invalid",
    handleDomains: [".entryway.atmosbox.test"],
    pds: [
      {
        id: "pds1",
        url: "https://pds1.entryway.atmosbox.test",
        internalUrl: "http://pds1:3000",
        did: "did:web:pds1.entryway.atmosbox.test",
        adminPassword: "test-admin",
      },
    ],
  };
  const calls = [];
  const remote = new Map();
  const plcHeads = new Map();
  const plcHistory = new Map();
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, body });
    const response = await reply?.({ method, body, calls });
    if (response)
      return Response.json(response.body ?? {}, {
        status: response.status ?? 200,
      });
    if (method === "com.atproto.server.reserveSigningKey")
      return Response.json({
        signingKey: (await Secp256k1Keypair.create()).did(),
      });
    if (method === "com.atproto.server.createAccount") {
      remote.set(body.did, {
        did: body.did,
        handle: body.handle,
        active: true,
      });
      plcHeads.set(body.did, body.plcOp);
      plcHistory.set(body.did, [body.plcOp]);
    }
    if (method === "com.atproto.admin.updateSubjectStatus")
      remote.get(body.subject.did).active = !body.deactivated.applied;
    if (method === "com.atproto.admin.updateAccountHandle")
      remote.get(body.did).handle = body.handle;
    if (method === "com.atproto.admin.deleteAccount") remote.delete(body.did);
    if (
      [
        "com.atproto.repo.describeRepo",
        "com.atproto.admin.getAccountInfo",
      ].includes(method)
    ) {
      const parsed = new URL(url);
      const row = remote.get(
        parsed.searchParams.get("repo") ?? parsed.searchParams.get("did"),
      );
      return row
        ? Response.json({
            did: row.did,
            handle: row.handle,
            ...(row.active ? {} : { deactivatedAt: "2026-10-06T00:00:00Z" }),
          })
        : Response.json(
            {
              error: method.endsWith("getAccountInfo")
                ? "NotFound"
                : "RepoNotFound",
            },
            { status: 404 },
          );
    }
    return Response.json({});
  };
  let db = await openTestDatabase(path);
  t.after(async () => {
    globalThis.fetch = previous;
    await db.close();
  });
  let accounts;
  const boot = async () => {
    accounts = await createAccounts({
      db,
      config,
      ...(ownershipFactory ? { ownership: ownershipFactory(db) } : {}),
    });
    accounts.plcClient.getLastOp = async (did) => plcHeads.get(did);
    accounts.plcClient.getAuditableLog = async (did) =>
      Promise.all(
        (plcHistory.get(did) ?? [plcHeads.get(did)]).map(async (operation) => ({
          did,
          operation,
          cid: String(await cidForCbor(operation)),
          nullified: false,
          createdAt: new Date().toISOString(),
        })),
      );
    accounts.plcClient.sendOperation = async (did, operation) => {
      plcHistory.set(did, [...(plcHistory.get(did) ?? []), operation]);
      plcHeads.set(did, operation);
    };
  };
  await boot();
  const recover = async (resource, action = "retry-if-safe") => {
    const attempt = await accounts.ownership.pendingExternal(resource);
    if (!attempt) throw Error("Missing pending fixture attempt");
    // This controlled transport has already returned; there is no queued work.
    // Real process/upstream isolation is exercised separately by the AiaB drill.
    await accounts.ownership.approveRecovery({
      ...(attempt.recovery
        ? {
            previousAuthorization: {
              id: attempt.recovery.id,
              version: attempt.recovery.version,
            },
          }
        : {}),
      operationId: attempt.operationId,
      externalAttemptId: attempt.id,
      executionAttemptId: attempt.executionAttemptId,
      target: attempt.target,
      action,
      dispatcherIsolationReference: "fixture:completed-callback",
      upstreamDrainReference: "fixture:no-outstanding-transport",
    });
  };
  return {
    get db() {
      return db;
    },
    get accounts() {
      return accounts;
    },
    config,
    calls,
    recover,
    remote,
    plcHeads,
    async reopen() {
      await db.close();
      db = await openTestDatabase(path);
      await boot();
    },
  };
}
export const alice = {
  email: "alice@example.com",
  handle: "alice.entryway.atmosbox.test",
  pdsId: "pds1",
};
