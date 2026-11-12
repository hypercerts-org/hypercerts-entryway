import { Secp256k1MigrationPlcSigner } from "../../dist/src/plc/signing.js";
import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { createServiceJwt } from "@atproto/xrpc-server";
import {
  incomingHandoffMethod,
  incomingCreationMethod,
} from "../../dist/src/features/external-migration/incoming-authorization.js";
import { arrivalCodeHash } from "../../dist/src/features/external-migration/prepare-arrival.js";
import { parseArrivalRequest } from "../../dist/src/features/external-migration/arrival-request.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { Secp256k1Keypair } from "@atproto/crypto";
import { cidForCbor } from "@atproto/common";
import * as plc from "@did-plc/lib";
import { ArrivalPdsClient } from "../../dist/src/pds/arrival-client.js";
import { composeIncomingArrival } from "../../dist/src/compose-incoming-arrival.mjs";
import { createBrowserFlow } from "../../dist/src/http/browser-flow.mjs";
import { createOperationOwnership } from "../../dist/src/accounts/operation-ownership.js";
import { createOperationOwnershipStore } from "../../dist/src/database/drizzle/operation-ownership.js";
import { createAccountStorage } from "../../dist/src/database/drizzle/account-storage.js";
import { createArrivalStorage } from "../../dist/src/database/drizzle/migration-arrival.js";
import { validateIncomingHandoff } from "../../dist/src/plc/policy.js";
import {
  failureTrigger,
  removeFailureTrigger,
  hasFailure,
  openTestDatabase,
  verifiedUser,
  query,
} from "../support/database-fixture.mjs";

const endpoint = "https://destination.example.test";
const sourceEndpoint = "https://source.example.test";
const email = "destination@example.test";
const handle = "destination.example.test";

async function fixture(t, mode = "modern", mutation = "", fault = "") {
  const directory = mkdtempSync(join(tmpdir(), "arrival-preparation-"));
  const path = join(directory, "authority.sqlite");
  let db = await openTestDatabase(path);
  t.after(async () => {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const source = await Secp256k1Keypair.create();
  const recovery = await Secp256k1Keypair.create();
  const hot = await Secp256k1Keypair.create({ exportable: true });
  const repository = await Secp256k1Keypair.create();
  let predecessor;
  if (mode === "legacy") {
    predecessor = await plc.deprecatedSignCreate(
      {
        type: "create",
        signingKey: source.did(),
        recoveryKey: recovery.did(),
        handle,
        service: sourceEndpoint,
        prev: null,
      },
      recovery,
    );
  } else {
    const keys = [recovery.did(), source.did()];
    if (mutation === "full")
      for (let index = 0; index < 3; index++)
        keys.push((await Secp256k1Keypair.create()).did());
    predecessor = await plc.signOperation(
      plc.formatAtprotoOp({
        signingKey: source.did(),
        handle: mutation === "distinct-handle" ? "source.example.test" : handle,
        pds: sourceEndpoint,
        rotationKeys: keys,
        prev: null,
      }),
      recovery,
    );
  }
  const did = await plc.didForCreateOp(predecessor);
  const head = String(await cidForCbor(predecessor));
  const audit = [
    {
      did,
      cid: head,
      operation: predecessor,
      nullified: false,
      createdAt: new Date().toISOString(),
    },
  ];
  if (mutation === "wrong-did") audit[0].did = `did:plc:${"a".repeat(24)}`;
  if (mutation === "signature") {
    audit[0].operation = { ...predecessor, sig: "invalid" };
    audit[0].cid = String(await cidForCbor(audit[0].operation));
  }
  if (mutation === "cid") audit[0].cid = "wrong";
  if (mutation === "nullified") audit[0].nullified = true;
  if (mutation === "tombstone") {
    const operation = await plc.signOperation(
      { type: "plc_tombstone", prev: head },
      source,
    );
    audit.push({
      did,
      operation,
      cid: String(await cidForCbor(operation)),
      nullified: false,
      createdAt: new Date().toISOString(),
    });
  }
  const hosts = [
    { id: "pds1", url: endpoint, did: "did:web:destination.example.test" },
  ];
  const storage = createAccountStorage(db, hosts);
  const arrivalStorage = () =>
    createArrivalStorage(db, hosts, {
      readAccount: (value) => storage.getByDid(value),
      readBinding: (value) => storage.getVerifiedBinding(value),
      reserveEmailClaim: (...args) => storage.reserveEmail(...args),
      reserveHandleClaim: (...args) => storage.reserveHandle(...args),
      recordSavedUserBinding: (subject, userId) =>
        db.insert(
          "account_bindings",
          { did: subject, user_id: userId },
          { ignoreConflict: true },
        ),
      insertPlacedAccount: (input) =>
        storage.insertAccount(
          {
            did: input.did,
            email: input.email,
            emailVerified: true,
            handle: input.handle,
            pdsId: input.pdsId,
            pdsUrl: input.pdsUrl,
            status: "provisioning",
            createdAt: new Date().toISOString(),
          },
          input.userId,
        ),
    });
  const arrivals = arrivalStorage();
  if (fault.startsWith("after-commit"))
    arrivals.recordAllocationIntent = async () => {
      throw new Error("interrupted before allocation intent");
    };
  await verifiedUser(db, "destination-user", email);
  const principal = {
    userId: "destination-user",
    email,
    emailVerified: true,
    sessionId: "session",
    kind: "better-auth",
    authenticatedAt: new Date(),
  };
  let verifications = 0;
  const authentication = {
    requireSession: async () => principal,
    verifySignInCode: async ({ email: destinationEmail, otp }) => {
      verifications++;
      assert.equal(destinationEmail, email);
      return {
        ok: otp === "fresh-otp",
        principal: {
          ...principal,
          ...(mutation === "wrong-user" ? { userId: "other-user" } : {}),
        },
      };
    },
  };
  const config = {
    inviteCodeRequired: true,
    pds: hosts,
    issuer: "https://entryway.example.test",
    clientUrl: "https://client.example.test",
    serviceDid: "did:web:entryway.example.test",
    betterAuthSecret: "unit-test-secret",
    jwtJwk: generateKeyPairSync("ec", {
      namedCurve: "secp256k1",
    }).privateKey.export({ format: "jwk" }),
  };
  const store = createOperationOwnershipStore(db);
  const ownership = createOperationOwnership({
    store: {
      ...store,
      async checkpoint(...args) {
        if (
          fault === "after-commit-complete-fails" &&
          args[1].phase === "complete" &&
          !completionFailed
        ) {
          completionFailed = true;
          throw new Error("completion interrupted");
        }
        if (fault === "before-checkpoint") throw new Error("checkpoint fault");
        await store.checkpoint(...args);
        if (fault === "after-checkpoint") throw new Error("checkpoint fault");
      },
      release: fault === "after-commit-crash" ? async () => {} : store.release,
    },
    heartbeatMs: 0,
  });
  let completionFailed = false;
  let publicationMode = "normal";
  let directoryReads = 0;
  let credentialsIssued = 0;
  const publicationAttempts = [];
  const accounts = {
    ownership,
    storage,
    get: (value) => storage.get(value),
    plcSigner: await Secp256k1MigrationPlcSigner.fromHex(
      Buffer.from(await hot.export()).toString("hex"),
    ),
    plcClient: {
      url: "https://plc.example.test",
      getAuditableLog: async () => {
        if (
          backendState.mode === "directory-outage" &&
          backendState.creates > 0
        )
          throw new Error("directory unavailable");
        return structuredClone(audit);
      },
      getDocument: async () => {
        directoryReads++;
        return plc.formatDidDoc({
          did,
          ...plc.normalizeOp(audit.at(-1).operation),
        });
      },
      sendOperation: async (subject, operation) => {
        assert.equal(subject, did);
        const admissions = await query(db, "SELECT * FROM arrival_replay");
        const signed = await query(
          db,
          "SELECT * FROM arrival_signed_operations",
        );
        assert.equal(
          admissions.filter((item) => item.method === incomingHandoffMethod)
            .length,
          1,
        );
        assert.equal(signed.length, 1);
        assert.deepEqual(JSON.parse(signed[0].operation), operation);
        publicationAttempts.push(structuredClone(operation));
        if (publicationMode === "lost-unapplied")
          throw new Error("response lost");
        audit.push({
          did,
          cid: String(await cidForCbor(operation)),
          operation: structuredClone(operation),
          nullified: false,
          createdAt: new Date().toISOString(),
        });
        if (publicationMode === "lost-applied")
          throw new Error("response lost");
      },
      getLastOp: async () =>
        mutation === "race"
          ? { ...predecessor, sig: "changed" }
          : audit.at(-1).operation,
    },
  };
  const browserFlow = createBrowserFlow({
    db,
    config,
    provider: {
      deviceManager: { load: async () => ({ deviceId: "browser" }) },
    },
  });
  const request = { headers: { origin: config.issuer }, body: {} };
  request.body.csrf = (await browserFlow.loadBrowser(request)).csrf;
  let reservations = 0;
  const backendState = {
    exists: false,
    deactivated: false,
    creates: 0,
    pauses: 0,
    mode: "normal",
    exactMove: null,
    adminExtras: {},
  };

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, options) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname.endsWith("getAccountInfo")) {
      assert.match(options.headers.authorization, /^Basic /);
      if (backendState.mode === "network")
        throw new Error("network unavailable");
      if (backendState.mode === "malformed") return Response.json({ did });
      if (!backendState.exists)
        return Response.json({ error: "NotFound" }, { status: 404 });
      return Response.json({
        did: backendState.mode === "wrong-did" ? "did:plc:wrong" : did,
        handle,
        indexedAt: new Date().toISOString(),
        ...backendState.adminExtras,
        ...(backendState.deactivated
          ? { deactivatedAt: new Date().toISOString() }
          : {}),
      });
    }
    if (parsedUrl.pathname.endsWith("createAccount")) {
      backendState.creates++;
      const body = JSON.parse(options.body);
      const recorded = (
        await query(
          db,
          "SELECT operation FROM arrival_signed_operations WHERE kind = 'destination-move'",
        )
      )[0];
      assert.deepEqual(body.plcOp, JSON.parse(recorded.operation));
      assert.equal((await arrivals.readArrivalAccess(did)).bound, false);
      assert.equal(body.handle, handle);
      assert.equal(body.did, did);
      assert.equal(body.plcOp.verificationMethods.atproto, repository.did());
      assert.equal(body.plcOp.services.atproto_pds.endpoint, endpoint);
      assert.equal(typeof body.plcOp.sig, "string");
      assert.ok(body.plcOp.sig.length > 0);
      backendState.exactMove = body.plcOp;
      if (backendState.mode === "creation-rejected")
        return Response.json({ error: "InvalidRequest" }, { status: 400 });
      if (backendState.mode !== "unchanged-head")
        audit.push({
          did,
          operation: body.plcOp,
          cid: String(await cidForCbor(body.plcOp)),
          nullified: false,
          createdAt: new Date().toISOString(),
        });
      if (backendState.mode === "malformed-head") audit.at(-1).cid = "invalid";
      if (backendState.mode !== "published-absent") backendState.exists = true;
      if (["creation-lost", "published-absent"].includes(backendState.mode))
        throw new Error("creation response lost");
      return Response.json({
        did,
        handle,
        accessJwt: "discarded-access",
        refreshJwt: "discarded-refresh",
      });
    }
    if (parsedUrl.pathname.endsWith("updateSubjectStatus")) {
      backendState.pauses++;
      assert.deepEqual(JSON.parse(options.body), {
        subject: { $type: "com.atproto.admin.defs#repoRef", did },
        deactivated: { applied: true },
      });
      assert.equal((await arrivals.readArrivalAccess(did)).bound, false);
      if (backendState.mode === "pause-rejected")
        return Response.json({ error: "InvalidRequest" }, { status: 400 });
      backendState.deactivated = true;
      if (backendState.mode === "pause-lost")
        throw new Error("pause response lost");
      return Response.json({});
    }
    reservations++;
    assert.equal(
      String(url),
      `${endpoint}/xrpc/com.atproto.server.reserveSigningKey`,
    );
    assert.deepEqual(JSON.parse(options.body), { did });
    assert.equal(options.headers.authorization, undefined);
    const rows = await query(db, "SELECT * FROM arrival_reservations");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].signing_key, null);
    if (mutation === "lost") throw new Error("reservation response lost");
    if (mutation === "http") return new Response("{}", { status: 503 });
    return Response.json({ signingKey: repository.did() });
  };
  const composed = await composeIncomingArrival({
    db,
    arrivals,
    config,
    accounts,
    authentication,
    browserFlow,
  });
  return {
    get db() {
      return db;
    },
    arrivals,
    backendState,
    async reopen() {
      await db.close();
      db = await openTestDatabase(path);
      return arrivalStorage();
    },
    request,
    config,
    principal,
    ownership,
    store,
    audit,
    publicationAttempts,
    setPublicationMode: (value) => {
      publicationMode = value;
    },
    directoryReads: () => directoryReads,
    credentialsIssued: () => credentialsIssued,
    async credential(method = incomingHandoffMethod, overrides = {}) {
      credentialsIssued++;
      if (overrides.jti !== undefined) {
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(
          JSON.stringify({ typ: "JWT", alg: "ES256K" }),
        ).toString("base64url");
        const payload = Buffer.from(
          JSON.stringify({
            iss: did,
            aud: config.serviceDid,
            lxm: method,
            iat: now,
            exp: now + 120,
            ...overrides,
          }),
        ).toString("base64url");
        const bytes = `${header}.${payload}`;
        return `Bearer ${bytes}.${Buffer.from(await source.sign(Buffer.from(bytes))).toString("base64url")}`;
      }
      return `Bearer ${await createServiceJwt({ iss: did, aud: config.serviceDid, lxm: method, keypair: source, ...overrides })}`;
    },
    did,
    predecessor,
    head,
    source,
    hot,
    repository,
    composed,
    reservations: () => reservations,
    verifications: () => verifications,
    prepare: (otp = "fresh-otp") =>
      composed.prepareArrival(request, otp, { did, handle }),
  };
}

for (const mode of ["modern", "legacy"]) {
  test(`composed ${mode} preparation retains signed predecessor and reserves only after durable intent`, async (t) => {
    const f = await fixture(t, mode);
    const result = await f.prepare();
    const saved = await f.arrivals.readArrival(
      result.operationId,
      "destination-user",
    );
    assert.deepEqual(saved.sourcePredecessor, f.predecessor);
    assert.equal(saved.sourcePlcHead, f.head);
    assert.equal(String(await cidForCbor(saved.sourcePredecessor)), f.head);
    assert.equal(result.expectedPlcHead, f.head);
    assert.equal(result.sourceEndpoint, sourceEndpoint);
    assert.equal(result.destinationEndpoint, endpoint);
    assert.deepEqual(saved.approvedRotationKeys, [
      ...plc.normalizeOp(f.predecessor).rotationKeys,
      f.hot.did(),
    ]);
    assert.equal(saved.codeHash.includes(result.arrivalCode), false);
    assert.deepEqual(
      Object.keys(result).sort(),
      [
        "operationId",
        "version",
        "arrivalCode",
        "expiresAt",
        "entrywayDid",
        "sourceEndpoint",
        "destinationEndpoint",
        "expectedPlcHead",
        "handoff",
      ].sort(),
    );
    assert.deepEqual(
      Object.keys(f.composed).sort(),
      [
        "admitCreation",
        "bindPending",
        "prepareArrival",
        "renewArrival",
        "cancelArrival",
        "admitIncoming",
        "continueHandoff",
        "continueCreation",
        "reconcileArrival",
      ].sort(),
    );
    assert.equal(
      (await query(f.db, "SELECT * FROM account_bindings")).length,
      0,
    );
    const signed = await plc.signOperation(result.handoff, f.source);
    await validateIncomingHandoff({
      operation: signed,
      expectedPredecessor: saved.sourcePredecessor,
      approvedRotationKeys: saved.approvedRotationKeys,
      source: saved.source,
    });
    const claim = await query(f.db, "SELECT * FROM operation_admissions");
    assert.ok(
      claim.some((row) => Object.values(row).includes(`arrival:${f.did}`)),
    );
    assert.equal(f.reservations(), 1);
  });
}

for (const mutation of [
  "wrong-did",
  "signature",
  "cid",
  "nullified",
  "tombstone",
  "race",
  "full",
  "wrong-user",
]) {
  test(`composed preparation rejects ${mutation} before persistence and allocation`, async (t) => {
    const f = await fixture(t, "modern", mutation);
    await assert.rejects(f.prepare());
    assert.equal(f.reservations(), 0);
    assert.equal((await query(f.db, "SELECT * FROM arrivals")).length, 0);
  });
}

for (const mutation of ["lost", "http"]) {
  test(`composed preparation retains placement and obligation after ${mutation} reservation response`, async (t) => {
    const f = await fixture(t, "modern", mutation);
    await assert.rejects(f.prepare());
    const rows = await query(f.db, "SELECT * FROM arrivals");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].endpoint, endpoint);
    assert.equal(
      (await query(f.db, "SELECT * FROM arrival_reservations")).length,
      1,
    );
    assert.equal(f.reservations(), 1);
  });
}

test("preparation rejects missing/stale OTP and existing origin/CSRF violations", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.prepare(""));
  await assert.rejects(f.prepare("stale-otp"));
  f.request.headers.origin = "https://wrong.example.test";
  await assert.rejects(f.prepare());
  f.request.headers.origin = "https://entryway.example.test";
  f.request.body.csrf = "wrong";
  await assert.rejects(f.prepare());
  assert.equal(f.reservations(), 0);
  assert.equal((await query(f.db, "SELECT * FROM arrivals")).length, 0);
});

for (const fault of ["before-checkpoint", "after-checkpoint"]) {
  test(`preparation rolls back arrival and code on ${fault} failure`, async (t) => {
    const f = await fixture(t, "modern", "", fault);
    await assert.rejects(f.prepare(), /checkpoint fault/);
    assert.equal(f.reservations(), 0);
    await f.reopen();
    for (const table of [
      "arrivals",
      "arrival_code",
      "arrival_reservations",
      "operation_admissions",
    ])
      assert.equal((await query(f.db, `SELECT * FROM ${table}`)).length, 0);
    const operations = await query(f.db, "SELECT * FROM authority_operations");
    assert.equal(operations.length, 1);
    assert.equal(Boolean(operations[0].pending), false);
    assert.equal(operations[0].state, "complete");
  });
}

for (const fault of ["after-commit-release", "after-commit-crash"]) {
  test(`committed preparation remains recoverable after ${fault} and database reopen`, async (t) => {
    const f = await fixture(t, "modern", "", fault);
    await assert.rejects(f.prepare(), /interrupted before allocation intent/);
    assert.equal(f.reservations(), 0);
    const arrivals = await f.reopen();
    const saved = (await query(f.db, "SELECT * FROM arrivals"))[0];
    const operation = (
      await query(f.db, "SELECT * FROM authority_operations")
    )[0];
    assert.equal(saved.operation_id, operation.id);
    assert.equal(Boolean(operation.pending), true);
    assert.equal(operation.phase, "arrival-prepared");
    const admissions = await query(f.db, "SELECT * FROM operation_admissions");
    assert.equal(admissions.length, 1);
    assert.equal(admissions[0].operation_id, saved.operation_id);
    if (fault === "after-commit-crash") {
      assert.ok(operation.worker_id);
      await f.db.update(
        "authority_operations",
        {
          lease_expires_at: (await f.db.databaseTime()) - 1,
        },
        eq(f.db.tables.authority_operations.id, operation.id),
      );
    } else assert.equal(operation.worker_id, null);
    const owner = createOperationOwnership({
      store: createOperationOwnershipStore(f.db),
      heartbeatMs: 0,
    });
    await owner.run(
      `arrival:${f.did}`,
      {
        kind: "public-arrival",
        request: { did: f.did, handle, userId: "destination-user" },
      },
      async () => {
        const claim = owner.currentClaim;
        assert.equal(claim.resumed, true);
        assert.equal(claim.operationId, saved.operation_id);
        assert.equal(claim.attempt, 2);
        const result = await arrivals.cancelArrival({
          owner: claim,
          operationId: saved.operation_id,
          expectedVersion: saved.version,
          ownerUserId: "destination-user",
          noRemoteObligation: true,
          plcStateUnchanged: true,
        });
        assert.equal(result.kind, "applied");
        await owner.checkpoint("complete", null);
      },
    );
    assert.equal(
      (await query(f.db, "SELECT * FROM operation_admissions")).length,
      0,
    );
    assert.equal(
      (await query(f.db, "SELECT * FROM arrivals WHERE active = 1")).length,
      0,
    );
  });
}

for (const mode of ["normal", "lost-applied", "lost-unapplied"]) {
  test(`authenticated handoff ${mode} retains exact journal and uses fenced recovery`, async (t) => {
    const f = await fixture(t);
    const prepared = await f.prepare();
    const operation = await plc.signOperation(prepared.handoff, f.source);
    f.setPublicationMode(mode);
    const input = {
      operationId: prepared.operationId,
      method: incomingHandoffMethod,
      body: { operation },
      presentation: await f.credential(),
      arrivalCode: prepared.arrivalCode,
    };
    if (mode === "normal") {
      assert.equal(
        (await f.composed.admitIncoming(f.request, input)).state,
        "published",
      );
    } else {
      await assert.rejects(f.composed.admitIncoming(f.request, input));
      await assert.rejects(
        f.composed.continueHandoff(f.request, prepared.operationId),
        { code: "OperationRecoveryRequired" },
      );
      const attempt = await f.ownership.pendingExternal(`arrival:${f.did}`);
      await f.store.approveRecovery({
        operationId: attempt.operationId,
        externalAttemptId: attempt.id,
        executionAttemptId: attempt.executionAttemptId,
        target: attempt.target,
        dispatcherIsolationReference: "test-dispatcher-stopped",
        upstreamDrainReference: "test-directory-drained",
        action: "retry-if-safe",
      });
      f.setPublicationMode("normal");
      assert.equal(
        (await f.composed.continueHandoff(f.request, prepared.operationId))
          .state,
        "published",
      );
    }
    assert.equal(
      f.publicationAttempts.length,
      mode === "lost-unapplied" ? 2 : 1,
    );
    for (const sent of f.publicationAttempts) assert.deepEqual(sent, operation);
    // Valid source key cutover does not require a new source credential on trusted continuation.
    const cutover = await plc.signOperation(
      {
        ...prepared.handoff,
        verificationMethods: { atproto: f.hot.did() },
        prev: String(await cidForCbor(operation)),
      },
      f.hot,
    );
    f.audit.push({
      did: f.did,
      cid: String(await cidForCbor(cutover)),
      operation: cutover,
      nullified: false,
      createdAt: new Date().toISOString(),
    });
    assert.equal(
      (await f.composed.continueHandoff(f.request, prepared.operationId)).state,
      "diverged",
    );
    assert.equal(
      f.publicationAttempts.length,
      mode === "lost-unapplied" ? 2 : 1,
    );
    f.principal.userId = "other-user";
    await assert.rejects(
      f.composed.continueHandoff(f.request, prepared.operationId),
      { code: "AccountNotFound" },
    );
  });
}

test("unresolved accepted handoff stays pending after a signed destination key cutover before canonical settlement", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  // The handoff adds rotation authority, but must preserve the source repository key.
  assert.equal(prepared.handoff.verificationMethods.atproto, f.source.did());
  const operation = await plc.signOperation(prepared.handoff, f.source);
  const cid = String(await cidForCbor(operation));
  f.setPublicationMode("lost-applied");
  await assert.rejects(
    f.composed.admitIncoming(f.request, {
      operationId: prepared.operationId,
      method: incomingHandoffMethod,
      body: { operation },
      presentation: await f.credential(),
      arrivalCode: prepared.arrivalCode,
    }),
    /response lost/,
  );
  const accepted = await f.arrivals.readArrivalAggregate(
    prepared.operationId,
    "destination-user",
  );
  assert.equal(accepted.admissions.length, 1);
  assert.equal(accepted.signedOperations.length, 1);
  assert.deepEqual(accepted.signedOperations[0].operation, operation);
  assert.equal(accepted.signedOperations[0].cid, cid);
  assert.equal(accepted.progress.canonicalHandoffCid, null);
  assert.equal(f.audit.at(-1).cid, cid);
  const attempt = await f.ownership.pendingExternal(`arrival:${f.did}`);
  assert.ok(attempt);

  // Model a real signed descendant, not an auth resolver disconnected from PLC
  // history. This supplies directory state only; it does not implement B3.
  const cutover = await plc.signOperation(
    {
      ...prepared.handoff,
      verificationMethods: { atproto: f.repository.did() },
      services: {
        ...prepared.handoff.services,
        atproto_pds: { type: "AtprotoPersonalDataServer", endpoint },
      },
      prev: cid,
    },
    f.hot,
  );
  const cutoverCid = String(await cidForCbor(cutover));
  f.audit.push({
    did: f.did,
    cid: cutoverCid,
    operation: cutover,
    nullified: false,
    createdAt: new Date().toISOString(),
  });
  assert.notEqual(cutoverCid, cid);
  assert.notEqual(cutover.verificationMethods.atproto, f.source.did());
  const readsBeforeRecovery = f.directoryReads();
  assert.equal(f.credentialsIssued(), 1);
  assert.equal(readsBeforeRecovery, 1);

  // A changed directory key cannot bypass generic isolation/drain approval.
  await assert.rejects(
    f.composed.continueHandoff(f.request, prepared.operationId),
    { code: "OperationRecoveryRequired" },
  );
  assert.deepEqual(f.publicationAttempts, [operation]);
  await f.store.approveRecovery({
    operationId: attempt.operationId,
    externalAttemptId: attempt.id,
    executionAttemptId: attempt.executionAttemptId,
    target: attempt.target,
    dispatcherIsolationReference: "test-dispatcher-stopped",
    upstreamDrainReference: "test-directory-drained",
    action: "retry-if-safe",
  });
  f.setPublicationMode("normal");
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(
      f.composed.continueHandoff(f.request, prepared.operationId),
      {
        code: "OperationRecoveryRequired",
        message:
          "The observed account state does not permit this recovery. Keep the account pending for operator investigation.",
      },
    );
  }
  const pending = await f.arrivals.readArrivalAggregate(
    prepared.operationId,
    "destination-user",
  );
  assert.equal(pending.progress.canonicalHandoffCid, null);
  assert.deepEqual(pending.admissions, accepted.admissions);
  assert.deepEqual(pending.signedOperations, accepted.signedOperations);
  const unresolved = await f.ownership.pendingExternal(`arrival:${f.did}`);
  assert.equal(unresolved.id, attempt.id);
  assert.equal(unresolved.state, "recovery-approved");
  assert.equal(unresolved.intentDigest, attempt.intentDigest);
  assert.equal(f.credentialsIssued(), 1);
  assert.equal(f.directoryReads(), readsBeforeRecovery);
  assert.deepEqual(f.publicationAttempts, [operation]);
  assert.equal(f.audit.length, 3);
  assert.equal(f.audit.at(-1).cid, cutoverCid);
  assert.equal(f.reservations(), 1);
  assert.equal((await query(f.db, "SELECT * FROM account_bindings")).length, 0);
});

test("fresh bodies have semantic server digests and reject unsupported fields", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const saved = await f.arrivals.readArrival(
    prepared.operationId,
    "destination-user",
  );
  const operation = await plc.signOperation(prepared.handoff, f.source);
  const reversed = Object.fromEntries(Object.entries(operation).reverse());
  const digest = (candidate) =>
    parseArrivalRequest(saved, incomingHandoffMethod, { operation: candidate })
      .requestDigest;
  assert.equal(digest(operation), digest(reversed));
  const keys = [
    "\uffff",
    "\ue000",
    "\ud800\udc00",
    "\ud800",
    "é",
    "e\u0301",
    "a",
    "Z",
  ];
  const nested = Object.fromEntries(
    keys.map((key) => [key, ["first", "second"]]),
  );
  const reordered = Object.fromEntries(Object.entries(nested).reverse());
  const parsed = parseArrivalRequest(saved, incomingHandoffMethod, {
    operation: { nested },
  });
  assert.deepEqual(Object.keys(parsed.operation.nested), [
    "Z",
    "a",
    "e\u0301",
    "é",
    "\ud800",
    "\ud800\udc00",
    "\ue000",
    "\uffff",
  ]);
  assert.equal(digest({ nested }), digest({ nested: reordered }));
  assert.notEqual(
    digest({ nested }),
    digest({ nested: { ...nested, Z: ["second", "first"] } }),
  );
  assert.notEqual(
    digest(operation),
    digest({
      ...operation,
      rotationKeys: [...operation.rotationKeys].reverse(),
    }),
  );
  assert.throws(() =>
    parseArrivalRequest(saved, incomingHandoffMethod, {
      operation,
      requestDigest: "a".repeat(64),
    }),
  );
  for (const field of [
    "password",
    "verificationCode",
    "verificationPhone",
    "recoveryKey",
    "plcOp",
    "unexpected",
  ])
    assert.throws(() =>
      parseArrivalRequest(saved, incomingCreationMethod, {
        handle,
        [field]: "unsupported",
      }),
    );
  assert.equal(
    parseArrivalRequest(saved, incomingCreationMethod, { handle })
      .requestDigest,
    parseArrivalRequest(saved, incomingCreationMethod, {
      handle: handle.toUpperCase(),
      did: f.did,
      email,
    }).requestDigest,
  );
  const wrong = await plc.signOperation(
    {
      ...prepared.handoff,
      prev: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    f.source,
  );
  await assert.rejects(
    f.composed.admitIncoming(f.request, {
      operationId: prepared.operationId,
      method: incomingHandoffMethod,
      body: { operation: wrong },
      presentation: await f.credential(),
      arrivalCode: prepared.arrivalCode,
    }),
  );
  assert.equal((await query(f.db, "SELECT * FROM arrival_replay")).length, 0);
  assert.equal(f.publicationAttempts.length, 0);
});

test("authenticated creation uses real invitation producer atomically without storing request secrets", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const input = {
    operationId: prepared.operationId,
    method: incomingCreationMethod,
    body: { handle },
    presentation: await f.credential(incomingCreationMethod),
    arrivalCode: prepared.arrivalCode,
  };
  await assert.rejects(
    f.composed.admitIncoming(f.request, input),
    /An invite code is required/,
  );
  assert.equal((await query(f.db, "SELECT * FROM arrival_replay")).length, 0);
  const { createInvites } =
    await import("../../dist/src/features/account-registration/invites.mjs");
  const invites = await createInvites({
    db: f.db,
    config: f.config,
    accounts: { get: async () => null },
  });
  const { code } = await invites.createInviteCode({ useCount: 1 });
  input.body.inviteCode = code;
  assert.equal(
    (await f.composed.admitIncoming(f.request, input)).state,
    "admitted",
  );
  const admissions = await query(f.db, "SELECT * FROM arrival_replay");
  assert.equal(admissions.length, 1);
  for (const secret of [code, prepared.arrivalCode, input.presentation])
    assert.equal(JSON.stringify(admissions).includes(secret), false);
  assert.equal(f.publicationAttempts.length, 0);
  // Admission is durable, but creation cannot proceed without the separately
  // accepted signed handoff. B3 no longer returns a metadata-only continuation.
  await assert.rejects(
    f.composed.continueCreation(f.request, prepared.operationId),
    { code: "OperationRecoveryRequired" },
  );
  assert.equal(
    (await query(f.db, "SELECT * FROM arrival_replay"))[0].request_digest,
    admissions[0].request_digest,
  );
});

test("composed creation rejects a submit-scoped credential before admission or destination effects", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const before = await f.arrivals.readArrivalAggregate(
    prepared.operationId,
    f.principal.userId,
  );
  await assert.rejects(
    f.composed.admitIncoming(f.request, {
      operationId: prepared.operationId,
      method: incomingCreationMethod,
      body: { handle },
      presentation: await f.credential(incomingHandoffMethod),
      arrivalCode: prepared.arrivalCode,
    }),
    { code: "AccountMismatch" },
  );
  assert.deepEqual(
    await f.arrivals.readArrivalAggregate(
      prepared.operationId,
      f.principal.userId,
    ),
    before,
  );
  assert.equal(f.backendState.creates, 0);
  assert.equal(f.backendState.pauses, 0);
  assert.equal(f.publicationAttempts.length, 0);
});

test("handoff journal failure rolls admission back before any dispatch", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const operation = await plc.signOperation(prepared.handoff, f.source);
  const record = f.arrivals.recordSignedOperation;
  f.arrivals.recordSignedOperation = async (...args) => {
    await record(...args);
    throw new Error("journal commit fault");
  };
  await assert.rejects(
    f.composed.admitIncoming(f.request, {
      operationId: prepared.operationId,
      method: incomingHandoffMethod,
      body: { operation },
      presentation: await f.credential(),
      arrivalCode: prepared.arrivalCode,
    }),
    /journal commit fault/,
  );
  assert.equal((await query(f.db, "SELECT * FROM arrival_replay")).length, 0);
  assert.equal(
    (await query(f.db, "SELECT * FROM arrival_signed_operations")).length,
    0,
  );
  assert.equal(f.publicationAttempts.length, 0);
});

test("verified credential jti cannot admit another incoming method", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const operation = await plc.signOperation(prepared.handoff, f.source);
  const jti = "same-verified-jti";
  await f.composed.admitIncoming(f.request, {
    operationId: prepared.operationId,
    method: incomingHandoffMethod,
    body: { operation },
    presentation: await f.credential(incomingHandoffMethod, { jti }),
    arrivalCode: prepared.arrivalCode,
  });
  await assert.rejects(
    f.composed.admitIncoming(f.request, {
      operationId: prepared.operationId,
      method: incomingCreationMethod,
      body: { handle },
      presentation: await f.credential(incomingCreationMethod, { jti }),
      arrivalCode: prepared.arrivalCode,
    }),
    { code: "OperationConflict" },
  );
  assert.equal((await query(f.db, "SELECT * FROM arrival_replay")).length, 1);
});

async function admitProvisioning(f, interruptHandoff = false) {
  const prepared = await f.prepare();
  const operation = await plc.signOperation(prepared.handoff, f.source);
  const dispatch = f.ownership.dispatch;
  if (interruptHandoff)
    f.ownership.dispatch = async () => {
      throw new Error("interrupted before handoff dispatch");
    };
  const handoff = f.composed.admitIncoming(f.request, {
    operationId: prepared.operationId,
    method: incomingHandoffMethod,
    body: { operation },
    presentation: await f.credential(),
    arrivalCode: prepared.arrivalCode,
  });
  if (interruptHandoff)
    await assert.rejects(handoff, /interrupted before handoff dispatch/);
  else await handoff;
  f.ownership.dispatch = dispatch;
  const { createInvites } =
    await import("../../dist/src/features/account-registration/invites.mjs");
  const invites = await createInvites({
    db: f.db,
    config: f.config,
    accounts: { get: async () => null },
  });
  const { code } = await invites.createInviteCode({ useCount: 1 });
  await f.composed.admitIncoming(f.request, {
    operationId: prepared.operationId,
    method: incomingCreationMethod,
    body: { handle, inviteCode: code },
    presentation: await f.credential(incomingCreationMethod),
    arrivalCode: prepared.arrivalCode,
  });
  return prepared;
}

test("reconciliation publishes the accepted unpublished handoff before admitted creation", async (t) => {
  const f = await fixture(t);
  const prepared = await admitProvisioning(f, true);
  const before = await f.arrivals.readArrivalAggregate(
    prepared.operationId,
    f.principal.userId,
  );
  assert.equal(before.admissions.length, 2);
  assert.equal(before.progress.canonicalHandoffCid, null);
  assert.equal(f.audit.at(-1).cid, f.head);
  assert.equal(f.publicationAttempts.length, 0);
  assert.equal(
    (await f.composed.reconcileArrival(f.request, prepared.operationId)).state,
    "pending",
  );
  const after = await f.arrivals.readArrivalAggregate(
    prepared.operationId,
    f.principal.userId,
  );
  assert.equal(
    after.progress.canonicalHandoffCid,
    before.signedOperations[0].cid,
  );
  assert.ok(after.progress.provisionedAt);
  assert.ok(after.progress.deactivatedAt);
  assert.ok(after.progress.boundAt);
  assert.deepEqual(after.admissions, before.admissions);
  assert.deepEqual(f.publicationAttempts, [
    before.signedOperations[0].operation,
  ]);
  assert.equal(f.backendState.creates, 1);
  assert.equal(f.backendState.pauses, 1);
  assert.equal(f.reservations(), 1);
  assert.equal(f.credentialsIssued(), 2);
  assert.equal(after.signedOperations.length, 2);
  assert.equal(
    f.audit.at(-1).cid,
    after.signedOperations.find((item) => item.kind === "destination-move").cid,
  );
});

for (const state of ["divergent", "tombstone", "unavailable"]) {
  test(`reconciliation with both admissions retains unpublished work when identity is ${state}`, async (t) => {
    const f = await fixture(t);
    const prepared = await admitProvisioning(f, true);
    const before = await f.arrivals.readArrivalAggregate(
      prepared.operationId,
      f.principal.userId,
    );
    if (state === "unavailable") f.audit[0].cid = "invalid";
    else {
      const operation = await plc.signOperation(
        state === "tombstone"
          ? { type: "plc_tombstone", prev: f.head }
          : {
              ...prepared.handoff,
              alsoKnownAs: ["at://unrelated.example.test"],
            },
        f.source,
      );
      f.audit.push({
        did: f.did,
        operation,
        cid: String(await cidForCbor(operation)),
        nullified: false,
        createdAt: new Date().toISOString(),
      });
    }
    await assert.rejects(
      f.composed.reconcileArrival(f.request, prepared.operationId),
    );
    assert.deepEqual(
      await f.arrivals.readArrivalAggregate(
        prepared.operationId,
        f.principal.userId,
      ),
      before,
    );
    assert.equal(f.backendState.creates, 0);
    assert.equal(f.backendState.pauses, 0);
    assert.equal(f.publicationAttempts.length, 0);
    assert.equal(f.reservations(), 1);
    assert.equal(f.credentialsIssued(), 2);
  });
}

for (const mode of ["creation-lost", "pause-lost"]) {
  test(`reconciliation at the exact destination move preserves ${mode} recovery fencing`, async (t) => {
    const f = await fixture(t);
    const prepared = await admitProvisioning(f);
    f.backendState.mode = mode;
    await assert.rejects(
      f.composed.continueCreation(f.request, prepared.operationId),
    );
    const before = await f.arrivals.readArrivalAggregate(
      prepared.operationId,
      f.principal.userId,
    );
    const move = before.signedOperations.find(
      (item) => item.kind === "destination-move",
    );
    assert.equal(f.audit.at(-1).cid, move.cid);
    await assert.rejects(
      f.composed.reconcileArrival(f.request, prepared.operationId),
      { code: "OperationRecoveryRequired" },
    );
    const pending = await f.store.pendingExternal(`arrival:${f.did}`);
    await f.store.approveRecovery({
      operationId: pending.operationId,
      externalAttemptId: pending.id,
      executionAttemptId: pending.executionAttemptId,
      target: pending.target,
      dispatcherIsolationReference: "test-dispatcher-isolated",
      upstreamDrainReference: "test-upstream-drained",
      action: "observe",
    });
    f.backendState.mode = "normal";
    await f.composed.reconcileArrival(f.request, prepared.operationId);
    const after = await f.arrivals.readArrivalAggregate(
      prepared.operationId,
      f.principal.userId,
    );
    assert.ok(after.progress.boundAt);
    assert.ok(after.progress.deactivatedAt);
    assert.ok(after.progress.provisionedAt);
    assert.deepEqual(after.signedOperations, before.signedOperations);
    assert.equal(f.backendState.creates, 1);
    assert.equal(f.backendState.pauses, 1);
    assert.equal(f.publicationAttempts.length, 1);
    assert.equal(f.reservations(), 1);
    assert.equal(f.credentialsIssued(), 2);
    assert.equal(await f.store.pendingExternal(`arrival:${f.did}`), null);
  });
}

for (const mode of [
  "normal",
  "creation-lost",
  "pause-lost",
  "creation-rejected",
  "pause-rejected",
  "published-absent",
  "network",
  "malformed",
  "wrong-did",
]) {
  test(`durable creation ${mode} uses saved move, administrator observation and fenced recovery`, async (t) => {
    const f = await fixture(t, "modern", "distinct-handle");
    const prepared = await admitProvisioning(f);
    f.backendState.mode = mode;
    if (mode === "wrong-did") f.backendState.exists = true;
    const continuation = () =>
      f.composed.continueCreation(f.request, prepared.operationId);
    if (mode === "normal") {
      const result = await continuation();
      assert.deepEqual(Object.keys(result).sort(), [
        "operationId",
        "state",
        "version",
      ]);
      assert.equal(result.state, "pending");
      assert.equal((await f.arrivals.readArrivalAccess(f.did)).complete, false);
      const aggregate = await f.arrivals.readArrivalAggregate(
        prepared.operationId,
        f.principal.userId,
      );
      const move = aggregate.signedOperations.find(
        (item) => item.kind === "destination-move",
      );
      assert.deepEqual(move.operation, f.backendState.exactMove);
      assert.equal(move.cid, String(await cidForCbor(move.operation)));
      assert.equal(
        move.operation.prev,
        aggregate.signedOperations.find((item) => item.kind === "handoff").cid,
      );
      assert.equal(f.audit.at(-1).cid, move.cid);
      assert.deepEqual(await continuation(), result);
      assert.equal(f.reservations(), 1);
      assert.equal(f.backendState.creates, 1);
      assert.equal(f.backendState.pauses, 1);
      assert.equal(f.backendState.exactMove.alsoKnownAs[0], `at://${handle}`);
      assert.notEqual(
        f.backendState.exactMove.alsoKnownAs[0],
        f.predecessor.alsoKnownAs[0],
      );
      assert.equal((await f.arrivals.readArrivalAccess(f.did)).bound, true);
    } else {
      await assert.rejects(continuation());
      assert.equal((await f.arrivals.readArrivalAccess(f.did)).bound, false);
      assert.equal(
        (
          await f.arrivals.readArrivalAggregate(
            prepared.operationId,
            f.principal.userId,
          )
        ).reservation.uncertainReason,
        null,
      );
      if (["creation-rejected", "pause-rejected"].includes(mode)) {
        const projection = await f.arrivals.readArrivalAccess(f.did);
        assert.equal(projection.provisioned, false);
        assert.equal(projection.deactivationObserved, false);
        const aggregate = await f.arrivals.readArrivalAggregate(
          prepared.operationId,
          f.principal.userId,
        );
        assert.equal(aggregate.signedOperations.length, 2);
        assert.equal(f.backendState.creates, 1);
        assert.equal(f.backendState.pauses, mode === "pause-rejected" ? 1 : 0);
      }
      if (["creation-lost", "pause-lost"].includes(mode)) {
        await assert.rejects(continuation(), {
          code: "OperationRecoveryRequired",
        });
        const pending = await f.store.pendingExternal(`arrival:${f.did}`);
        await f.store.approveRecovery({
          operationId: pending.operationId,
          externalAttemptId: pending.id,
          executionAttemptId: pending.executionAttemptId,
          target: pending.target,
          dispatcherIsolationReference: "test-dispatcher-isolated",
          upstreamDrainReference: "test-upstream-drained",
          action: "observe",
        });
        f.backendState.mode = "normal";
        assert.equal((await continuation()).state, "pending");
        assert.equal(f.backendState.creates, 1);
        assert.equal(f.backendState.pauses, 1);
      }
      if (mode === "published-absent") {
        await assert.rejects(continuation(), {
          code: "OperationRecoveryRequired",
        });
        assert.equal(f.backendState.creates, 1);
        assert.equal(f.reservations(), 1);
      }
    }
  });
}

test("durable bind rollback retries exact saved move without another remote effect", async (t) => {
  const f = await fixture(t);
  const prepared = await admitProvisioning(f);
  await failureTrigger(
    f.db,
    "reject_arrival_binding",
    "account_bindings",
    "bind rollback",
  );
  await assert.rejects(
    f.composed.continueCreation(f.request, prepared.operationId),
    hasFailure("bind rollback"),
  );
  assert.equal((await f.arrivals.readArrivalAccess(f.did)).bound, false);
  assert.equal((await query(f.db, "SELECT * FROM accounts")).length, 0);
  const exact = structuredClone(f.backendState.exactMove);
  await removeFailureTrigger(
    f.db,
    "reject_arrival_binding",
    "account_bindings",
  );
  assert.equal(
    (await f.composed.continueCreation(f.request, prepared.operationId)).state,
    "pending",
  );
  assert.deepEqual(f.backendState.exactMove, exact);
  assert.equal(f.backendState.creates, 1);
  assert.equal(f.backendState.pauses, 1);
});

test("saved move tampering and unrelated canonical descendants never dispatch creation", async (t) => {
  const f = await fixture(t);
  const prepared = await admitProvisioning(f);
  f.backendState.mode = "network";
  await assert.rejects(
    f.composed.continueCreation(f.request, prepared.operationId),
  );
  const handoff = f.audit.at(-1).operation;
  const { sig: _signature, ...unsigned } = handoff;
  const unrelated = await plc.signOperation(
    {
      ...unsigned,
      prev: String(await cidForCbor(handoff)),
      alsoKnownAs: ["at://unrelated.example.test"],
    },
    f.hot,
  );
  f.audit.push({
    did: f.did,
    operation: unrelated,
    cid: String(await cidForCbor(unrelated)),
    nullified: false,
    createdAt: new Date().toISOString(),
  });
  f.backendState.mode = "normal";
  await assert.rejects(
    f.composed.continueCreation(f.request, prepared.operationId),
    { code: "OperationRecoveryRequired" },
  );
  assert.equal(f.backendState.creates, 0);
  f.audit.pop();
  // Force a saved move then fail before remote creation; retry must not re-sign.
  f.backendState.mode = "malformed";
  const read = f.arrivals.readArrivalAggregate;
  f.arrivals.readArrivalAggregate = async (...args) => {
    const aggregate = await read(...args);
    if (
      aggregate?.signedOperations.some(
        (item) => item.kind === "destination-move",
      )
    ) {
      const item = aggregate.signedOperations.find(
        (record) => record.kind === "destination-move",
      );
      item.operation.services.atproto_pds.endpoint =
        "https://wrong.example.test";
    }
    return aggregate;
  };
  f.backendState.mode = "normal";
  await assert.rejects(
    f.composed.continueCreation(f.request, prepared.operationId),
    { code: "OperationConflict" },
  );
  assert.equal(f.backendState.creates, 0);
});

for (const mode of [
  "existing-actor",
  "unchanged-head",
  "malformed-head",
  "directory-outage",
]) {
  test(`creation cannot settle from actor presence with ${mode}`, async (t) => {
    const f = await fixture(t);
    const prepared = await admitProvisioning(f);
    const acceptedInvites = await f.db.list("entryway:invites");
    const before = await f.arrivals.readArrivalAggregate(
      prepared.operationId,
      f.principal.userId,
    );
    f.backendState.mode = mode;
    if (mode === "existing-actor") f.backendState.exists = true;
    await assert.rejects(
      f.composed.continueCreation(f.request, prepared.operationId),
    );
    const after = await f.arrivals.readArrivalAggregate(
      prepared.operationId,
      f.principal.userId,
    );
    assert.equal(after.progress.provisionedAt, null);
    assert.equal(after.progress.boundAt, null);
    assert.equal(f.backendState.pauses, 0);
    assert.equal((await f.arrivals.readArrivalAccess(f.did)).bound, false);
    assert.deepEqual(await f.db.list("entryway:invites"), acceptedInvites);
    if (mode === "existing-actor") {
      assert.deepEqual(after.signedOperations, before.signedOperations);
      assert.equal(f.backendState.creates, 0);
    }
  });
}

for (const field of [
  "privateKey",
  "accessJwt",
  "refreshJwt",
  "signingSecret",
]) {
  for (const nested of [false, true]) {
    test(`administrator observation rejects ${nested ? "nested" : "top-level"} ${field} without retaining material`, async (t) => {
      const f = await fixture(t);
      const prepared = await admitProvisioning(f);
      const marker = Buffer.from(await f.hot.export()).toString("hex");
      f.backendState.adminExtras = nested
        ? { relatedRecords: [{ credentials: { [field]: marker } }] }
        : { [field]: marker };
      const logged = [];
      for (const method of ["log", "warn", "error", "info", "debug"])
        t.mock.method(console, method, (...args) => logged.push(args));
      await assert.rejects(
        f.composed.continueCreation(f.request, prepared.operationId),
        (error) => {
          assert.equal(error.code, "AccountUnavailable");
          assert.equal(String(error).includes(marker), false);
          return true;
        },
      );
      assert.equal(f.backendState.creates, 1);
      assert.equal(f.backendState.pauses, 0);
      assert.equal((await f.arrivals.readArrivalAccess(f.did)).bound, false);
      const persisted = await query(f.db, "SELECT * FROM key_value_state");
      const aggregate = await f.arrivals.readArrivalAggregate(
        prepared.operationId,
        f.principal.userId,
      );
      assert.equal(aggregate.progress.provisionedAt, null);
      assert.equal(
        JSON.stringify({ logged, persisted, aggregate }).includes(marker),
        false,
      );
    });
  }
}

test("administrator observation permits stock nonsecret additive account fields", async (t) => {
  const f = await fixture(t);
  f.backendState.exists = true;
  f.backendState.adminExtras = {
    email,
    relatedRecords: [
      { $type: "app.bsky.actor.profile", displayName: "Public profile" },
    ],
    invites: [],
    invitesDisabled: false,
    emailConfirmedAt: new Date().toISOString(),
    inviteNote: "Operator note",
    threatSignatures: [{ property: "public-test", value: "public-value" }],
  };
  const transport = new ArrivalPdsClient({
    endpoint,
    did: f.did,
    pdsDid: f.config.pds[0].did,
    issuer: f.config.serviceDid,
    jwtJwk: f.config.jwtJwk,
  });
  assert.deepEqual(await transport.getAccountInfo(() => "Basic test"), {
    did: f.did,
    handle,
    deactivated: false,
  });
});

test("existing actor under handoff cannot reconcile a previously saved move", async (t) => {
  const f = await fixture(t);
  const prepared = await admitProvisioning(f);
  f.backendState.mode = "unchanged-head";
  await assert.rejects(
    f.composed.continueCreation(f.request, prepared.operationId),
  );
  const before = await f.arrivals.readArrivalAggregate(
    prepared.operationId,
    f.principal.userId,
  );
  assert.equal(
    before.signedOperations.filter((item) => item.kind === "destination-move")
      .length,
    1,
  );
  const receipt = await f.store.pendingExternal(`arrival:${f.did}`);
  assert.ok(receipt);
  await f.store.approveRecovery({
    operationId: receipt.operationId,
    externalAttemptId: receipt.id,
    executionAttemptId: receipt.executionAttemptId,
    target: receipt.target,
    dispatcherIsolationReference: "test-dispatcher-isolated",
    upstreamDrainReference: "test-upstream-drained",
    action: "observe",
  });
  f.backendState.mode = "normal";
  await assert.rejects(
    f.composed.continueCreation(f.request, prepared.operationId),
    { code: "OperationRecoveryRequired" },
  );
  const after = await f.arrivals.readArrivalAggregate(
    prepared.operationId,
    f.principal.userId,
  );
  assert.deepEqual(after.signedOperations, before.signedOperations);
  assert.equal(after.progress.provisionedAt, null);
  assert.equal(after.progress.boundAt, null);
  assert.equal(f.backendState.creates, 1);
  assert.equal(f.backendState.pauses, 0);
  assert.equal(
    (await f.store.pendingExternal(`arrival:${f.did}`)).id,
    receipt.id,
  );
});

const renew = (f, operationId, expectedVersion, otp = "fresh-otp") =>
  f.composed.renewArrival(f.request, otp, { operationId, expectedVersion });
const cancel = (f, operationId, expectedVersion, otp = "fresh-otp") =>
  f.composed.cancelArrival(f.request, otp, { operationId, expectedVersion });
const consume = (f, code) =>
  f.arrivals.consumeArrivalCode({
    codeHash: arrivalCodeHash(code),
    did: f.did,
    method: "com.atproto.server.createAccount",
  });
const stored = async (f) => ({
  arrivals: await query(f.db, "SELECT * FROM arrivals"),
  code: await query(f.db, "SELECT * FROM arrival_code"),
  reservations: await query(f.db, "SELECT * FROM arrival_reservations"),
});

test("renewal recovers a lost preparation response without another allocation", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  assert.equal(f.reservations(), 1);
  const renewed = await renew(f, prepared.operationId, prepared.version);
  assert.deepEqual(Object.keys(renewed).sort(), [
    "arrivalCode",
    "expiresAt",
    "operationId",
    "version",
  ]);
  assert.equal(renewed.operationId, prepared.operationId);
  assert.equal(renewed.version, prepared.version + 1);
  assert.notEqual(renewed.arrivalCode, prepared.arrivalCode);
  // The prior generation fails the same way an unknown code does.
  assert.equal(await consume(f, prepared.arrivalCode), null);
  assert.equal(
    (await consume(f, renewed.arrivalCode)).operationId,
    prepared.operationId,
  );
  const rows = await stored(f);
  assert.equal(rows.arrivals.length, 1);
  assert.equal(rows.reservations.length, 1);
  assert.equal(f.reservations(), 1);
  assert.equal(
    JSON.stringify(rows).includes(renewed.arrivalCode),
    false,
    "only a hash is persisted",
  );
  // The reservation obligation is untouched and no second operation exists.
  assert.equal(rows.reservations[0].signing_key, f.repository.did());
  assert.equal(
    (await query(f.db, "SELECT * FROM operation_admissions")).length,
    1,
  );
});

test("renewal after a lost reservation response keeps the pending allocation", async (t) => {
  const f = await fixture(t, "modern", "lost");
  await assert.rejects(f.prepare());
  const saved = (await stored(f)).arrivals[0];
  const renewed = await renew(f, saved.operation_id, saved.version);
  assert.equal(renewed.version, saved.version + 1);
  assert.equal(f.reservations(), 1);
  const rows = await stored(f);
  assert.equal(rows.reservations.length, 1);
  assert.equal(rows.reservations[0].signing_key, null);
});

test("stale or simultaneous renewal conflicts and one generation survives", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const results = await Promise.allSettled([
    renew(f, prepared.operationId, prepared.version),
    renew(f, prepared.operationId, prepared.version),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const failed = results.find((item) => item.status === "rejected");
  assert.equal(failed.reason.code, "OperationConflict");
  const winner = results.find((item) => item.status === "fulfilled").value;
  assert.equal((await consume(f, winner.arrivalCode)) !== null, true);
  assert.equal((await stored(f)).code[0].generation, 2);
  await assert.rejects(renew(f, prepared.operationId, prepared.version), {
    code: "OperationConflict",
  });
  // The saved version, not a guess, advances the next renewal.
  const second = await renew(f, prepared.operationId, winner.version);
  assert.equal(await consume(f, winner.arrivalCode), null);
  assert.notEqual(await consume(f, second.arrivalCode), null);
});

for (const operation of [renew, cancel]) {
  test(`${operation === renew ? "renewal" : "cancellation"} treats another owner and an unknown operation identically`, async (t) => {
    const f = await fixture(t);
    const prepared = await f.prepare();
    const before = await stored(f);
    const unknown = await operation(f, "unknown-operation", 1).catch(
      (error) => error,
    );
    f.principal.userId = "other-user";
    const foreign = await operation(f, prepared.operationId, 1).catch(
      (error) => error,
    );
    f.principal.userId = "destination-user";
    for (const error of [unknown, foreign]) {
      assert.equal(error.code, "AccountNotFound");
      assert.equal(error.status, 404);
    }
    assert.equal(foreign.message, unknown.message);
    assert.deepEqual(await stored(f), before);
  });

  test(`${operation === renew ? "renewal" : "cancellation"} refuses missing proof, stale proof and browser origin or CSRF violations`, async (t) => {
    const f = await fixture(t);
    const prepared = await f.prepare();
    const before = await stored(f);
    const call = (otp) => operation(f, prepared.operationId, 1, otp);
    for (const otp of ["", "stale-otp"])
      await assert.rejects(call(otp), {
        error: "ArrivalProofRequired",
        status: 403,
      });
    f.request.headers.origin = "https://wrong.example.test";
    await assert.rejects(call("fresh-otp"));
    f.request.headers.origin = "https://entryway.example.test";
    const csrf = f.request.body.csrf;
    f.request.body.csrf = "wrong";
    await assert.rejects(call("fresh-otp"));
    f.request.body.csrf = csrf;
    f.principal.emailVerified = false;
    await assert.rejects(call("fresh-otp"), {
      error: "ArrivalProofRequired",
      status: 403,
    });
    f.principal.emailVerified = true;
    for (const body of [
      { operationId: prepared.operationId },
      { operationId: prepared.operationId, expectedVersion: "1" },
      { operationId: prepared.operationId, expectedVersion: 0 },
      { operationId: 7, expectedVersion: 1 },
    ])
      await assert.rejects(
        f.composed[operation === renew ? "renewArrival" : "cancelArrival"](
          f.request,
          "fresh-otp",
          body,
        ),
        { error: "InvalidRequest", status: 400 },
      );
    assert.deepEqual(await stored(f), before);
    assert.equal(f.reservations(), 1);
  });
}

const inviteFor = async (f) => {
  const { createInvites } =
    await import("../../dist/src/features/account-registration/invites.mjs");
  const invites = await createInvites({
    db: f.db,
    config: f.config,
    accounts: { get: async () => null },
  });
  return (await invites.createInviteCode({ useCount: 1 })).code;
};
const admitHandoff = async (f, prepared) =>
  f.composed.admitIncoming(f.request, {
    operationId: prepared.operationId,
    method: incomingHandoffMethod,
    body: { operation: await plc.signOperation(prepared.handoff, f.source) },
    presentation: await f.credential(),
    arrivalCode: prepared.arrivalCode,
  });
const admitCreation = async (f, prepared, arrivalCode, inviteCode) =>
  f.composed.admitIncoming(f.request, {
    operationId: prepared.operationId,
    method: incomingCreationMethod,
    body: { handle, inviteCode },
    presentation: await f.credential(incomingCreationMethod),
    arrivalCode,
  });
const versionOf = async (f, prepared) =>
  (await f.arrivals.readArrival(prepared.operationId, "destination-user"))
    .version;

test("renewal after the handoff admission keeps its continuation and supersedes the old code for new admissions", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  await admitHandoff(f, prepared);
  const signed = await query(f.db, "SELECT * FROM arrival_signed_operations");
  const admissions = await query(f.db, "SELECT * FROM arrival_replay");
  const renewed = await renew(
    f,
    prepared.operationId,
    await versionOf(f, prepared),
  );
  // The recorded admission and signed facts are untouched and nothing new is
  // reserved, signed or published by renewal.
  assert.deepEqual(
    await query(f.db, "SELECT * FROM arrival_replay"),
    admissions,
  );
  assert.deepEqual(
    await query(f.db, "SELECT * FROM arrival_signed_operations"),
    signed,
  );
  assert.equal(f.reservations(), 1);
  assert.equal(f.publicationAttempts.length, 1);
  assert.equal(admissions[0].generation, 1);
  const continued = await f.composed.continueHandoff(
    f.request,
    prepared.operationId,
  );
  assert.equal(continued.state, "published");
  assert.equal(f.publicationAttempts.length, 1);
  // A superseded code admits nothing new and consumes nothing; the new one does.
  const invite = await inviteFor(f);
  await assert.rejects(
    admitCreation(f, prepared, prepared.arrivalCode, invite),
    {
      error: "ArrivalExpired",
      status: 409,
    },
  );
  assert.equal((await query(f.db, "SELECT * FROM arrival_replay")).length, 1);
  assert.equal(
    (await admitCreation(f, prepared, renewed.arrivalCode, invite)).state,
    "admitted",
  );
  const replay = await query(f.db, "SELECT * FROM arrival_replay");
  assert.deepEqual(replay.map((row) => row.generation).sort(), [1, 2]);
  const result = await f.composed.continueCreation(
    f.request,
    prepared.operationId,
  );
  assert.equal(result.state, "pending");
  assert.equal(f.backendState.creates, 1);
  assert.equal(f.reservations(), 1);
  assert.equal(f.publicationAttempts.length, 1);
  assert.equal(
    (await query(f.db, "SELECT * FROM arrival_signed_operations")).length,
    2,
  );
});

test("renewal after the creation admission leaves the creation continuation able to complete", async (t) => {
  const f = await fixture(t);
  const prepared = await admitProvisioning(f);
  const admissions = await query(f.db, "SELECT * FROM arrival_replay");
  const renewed = await renew(
    f,
    prepared.operationId,
    await versionOf(f, prepared),
  );
  assert.notEqual(renewed.arrivalCode, prepared.arrivalCode);
  assert.deepEqual(
    await query(f.db, "SELECT * FROM arrival_replay"),
    admissions,
  );
  assert.equal(await consume(f, prepared.arrivalCode), null);
  const result = await f.composed.continueCreation(
    f.request,
    prepared.operationId,
  );
  assert.equal(result.state, "pending");
  assert.equal(f.backendState.creates, 1);
  assert.equal(f.reservations(), 1);
  assert.equal(f.publicationAttempts.length, 1);
  // Reconciliation also resumes from the saved admissions, not the new code.
  await f.composed.reconcileArrival(f.request, prepared.operationId);
  assert.equal(f.backendState.creates, 1);
  assert.equal(f.reservations(), 1);
});

test("an admission recorded above the current generation is never continued", async (t) => {
  const f = await fixture(t);
  const prepared = await admitProvisioning(f);
  await f.db.update(
    "arrival_replay",
    { generation: 5 },
    eq(f.db.tables.arrival_replay.operation_id, prepared.operationId),
  );
  await assert.rejects(
    f.composed.continueCreation(f.request, prepared.operationId),
    { code: "AccountMismatch" },
  );
  assert.equal(f.backendState.creates, 0);
});

test("cancelling a prepared arrival retains every obligation", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const before = await stored(f);
  const admissions = await query(f.db, "SELECT * FROM operation_admissions");
  await assert.rejects(cancel(f, prepared.operationId, prepared.version), {
    code: "OperationRecoveryRequired",
    status: 409,
  });
  assert.deepEqual(await stored(f), before);
  assert.deepEqual(
    await query(f.db, "SELECT * FROM operation_admissions"),
    admissions,
  );
  assert.equal((await stored(f)).arrivals[0].cancelled_at, null);
  assert.notEqual(await consume(f, prepared.arrivalCode), null);
  assert.equal(f.reservations(), 1);
});

test("cancelling an admitted arrival with signed facts retains every obligation", async (t) => {
  const g = await fixture(t);
  const admitted = await admitProvisioning(g);
  const saved = await g.arrivals.readArrival(
    admitted.operationId,
    "destination-user",
  );
  const kept = await stored(g);
  await assert.rejects(cancel(g, admitted.operationId, saved.version), {
    code: "OperationRecoveryRequired",
  });
  assert.deepEqual(await stored(g), kept);
});

test("cancelling a stale version conflicts before any obligation check", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  await assert.rejects(cancel(f, prepared.operationId, prepared.version + 5), {
    code: "OperationConflict",
  });
});

test("pre-intent cancellation releases local state only with unchanged canonical PLC head and is idempotent", async (t) => {
  const f = await fixture(t, "modern", "", "after-commit-release");
  await assert.rejects(f.prepare(), /interrupted before allocation intent/);
  const saved = (await stored(f)).arrivals[0];
  assert.equal((await stored(f)).reservations.length, 0);
  // A changed canonical head blocks cancellation.
  const { sig: _signature, ...unsigned } = f.predecessor;
  const descendant = await plc.signOperation(
    {
      ...unsigned,
      prev: f.head,
      alsoKnownAs: ["at://changed.example.test"],
    },
    f.source,
  );
  f.audit.push({
    did: f.did,
    operation: descendant,
    cid: String(await cidForCbor(descendant)),
    nullified: false,
    createdAt: new Date().toISOString(),
  });
  await assert.rejects(cancel(f, saved.operation_id, saved.version), {
    code: "OperationRecoveryRequired",
  });
  assert.equal((await stored(f)).arrivals[0].active, 1);
  f.audit.pop();
  const cancelled = await cancel(f, saved.operation_id, saved.version);
  assert.deepEqual(cancelled, {
    operationId: saved.operation_id,
    version: saved.version + 1,
    state: "cancelled",
  });
  const rows = await stored(f);
  assert.equal(rows.arrivals[0].active, 0);
  assert.notEqual(rows.arrivals[0].cancelled_at, null);
  assert.equal(rows.reservations.length, 0);
  assert.equal(
    (await query(f.db, "SELECT * FROM operation_admissions")).length,
    0,
  );
  assert.equal(f.reservations(), 0);
  // History is retained and an exact retry is idempotent, even after the
  // saved version has advanced.
  assert.deepEqual(
    await cancel(f, saved.operation_id, saved.version),
    cancelled,
  );
  assert.deepEqual(
    await cancel(f, saved.operation_id, cancelled.version),
    cancelled,
  );
  await assert.rejects(renew(f, saved.operation_id, cancelled.version), {
    error: "ArrivalExpired",
    status: 409,
  });
});

const preIntent = async (t, fault = "after-commit-release") => {
  const f = await fixture(t, "modern", "", fault);
  await assert.rejects(f.prepare(), /interrupted before allocation intent/);
  return { f, saved: (await stored(f)).arrivals[0] };
};
const pendingOperations = async (f) =>
  (await query(f.db, "SELECT * FROM authority_operations")).filter((row) =>
    Boolean(row.pending),
  ).length;
const admissionRows = async (f) =>
  (await query(f.db, "SELECT * FROM operation_admissions")).length;

test("concurrent cancellations are both idempotent and never leak a lost-claim error", async (t) => {
  const { f, saved } = await preIntent(t);
  const results = await Promise.allSettled([
    cancel(f, saved.operation_id, saved.version),
    cancel(f, saved.operation_id, saved.version),
  ]);
  assert.deepEqual(
    results.map((item) => item.status),
    ["fulfilled", "fulfilled"],
  );
  assert.deepEqual(results[1].value, results[0].value);
  assert.equal(results[0].value.state, "cancelled");
  assert.equal(await pendingOperations(f), 0);
});

test("renewal racing a cancellation reports the arrival as no longer actionable", async (t) => {
  const { f, saved } = await preIntent(t);
  const [cancelled, renewed] = await Promise.allSettled([
    cancel(f, saved.operation_id, saved.version),
    renew(f, saved.operation_id, saved.version),
  ]);
  assert.equal(cancelled.status, "fulfilled");
  assert.equal(renewed.status, "rejected");
  assert.equal(renewed.reason.error, "ArrivalExpired");
  assert.equal(renewed.reason.status, 409);
});

test("a crash after the local cancel commit leaves the claim pending until an exact retry completes it", async (t) => {
  const { f, saved } = await preIntent(t, "after-commit-complete-fails");
  assert.equal(await pendingOperations(f), 1);
  assert.equal(await admissionRows(f), 1);
  await assert.rejects(
    cancel(f, saved.operation_id, saved.version),
    /completion interrupted/,
  );
  const rows = (await stored(f)).arrivals[0];
  assert.notEqual(rows.cancelled_at, null);
  assert.equal(rows.active, 0);
  assert.equal(await pendingOperations(f), 1);
  assert.equal(await admissionRows(f), 1);
  const retried = await cancel(f, saved.operation_id, saved.version);
  assert.deepEqual(retried, {
    operationId: saved.operation_id,
    version: saved.version + 1,
    state: "cancelled",
  });
  assert.equal(await pendingOperations(f), 0);
  assert.equal(await admissionRows(f), 0);
});

for (const operation of [renew, cancel]) {
  test(`${operation === renew ? "renewal" : "cancellation"} origin and CSRF failures spend no proof or budget`, async (t) => {
    const f = await fixture(t);
    const prepared = await f.prepare();
    const purpose = operation === renew ? "incoming-renew" : "incoming-cancel";
    const budget = () =>
      f.db.get("entryway:limits", `${purpose}:destination-user`);
    const verified = f.verifications();
    const before = await budget();
    f.request.headers.origin = "https://wrong.example.test";
    const origin = await operation(f, prepared.operationId, 1).catch((e) => e);
    f.request.headers.origin = "https://entryway.example.test";
    const csrf = f.request.body.csrf;
    f.request.body.csrf = "wrong";
    const token = await operation(f, prepared.operationId, 1).catch((e) => e);
    f.request.body.csrf = csrf;
    for (const error of [origin, token]) {
      assert.ok(error instanceof Error);
      assert.equal(typeof error.status, "number");
      assert.ok(error.status >= 400 && error.status < 500);
      assert.notEqual(error.error, "ArrivalProofRequired");
    }
    assert.equal(f.verifications(), verified);
    assert.deepEqual(await budget(), before);
    // A malformed body is refused before the code is verified or budget spent.
    await assert.rejects(
      f.composed[operation === renew ? "renewArrival" : "cancelArrival"](
        f.request,
        "fresh-otp",
        { operationId: prepared.operationId },
      ),
      { error: "InvalidRequest", status: 400 },
    );
    assert.equal(f.verifications(), verified);
    assert.deepEqual(await budget(), before);
  });
}

test("storage compare-and-swap rejects a stale or racing renewal directly", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const rotate = (hash, expectedVersion) =>
    f.arrivals.rotateArrivalCode({
      operationId: prepared.operationId,
      ownerUserId: "destination-user",
      expectedVersion,
      codeHash: arrivalCodeHash(hash),
      codeExpiresAt: Date.now() + 86_400_000,
    });
  const results = await Promise.allSettled([
    rotate("first", prepared.version),
    rotate("second", prepared.version),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(
    results.find((item) => item.status === "rejected").reason.code,
    "OperationConflict",
  );
  await assert.rejects(rotate("third", prepared.version), {
    code: "OperationConflict",
  });
  assert.equal((await stored(f)).code[0].generation, 2);
});

test("renewal refuses a provisioned or completed arrival and an uncertain allocation", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const table = f.db.tables.arrival_reservations;
  await f.db.update(
    "arrival_reservations",
    { uncertain_reason: "response-lost", uncertain_at: Date.now() },
    eq(table.operation_id, prepared.operationId),
  );
  await assert.rejects(renew(f, prepared.operationId, prepared.version), {
    code: "OperationRecoveryRequired",
  });
  await f.db.update(
    "arrival_reservations",
    { uncertain_reason: null, uncertain_at: null },
    eq(table.operation_id, prepared.operationId),
  );
  const now = Date.now();
  await f.db.update(
    "arrivals",
    { provisioned_at: now },
    eq(f.db.tables.arrivals.operation_id, prepared.operationId),
  );
  await assert.rejects(renew(f, prepared.operationId, prepared.version), {
    error: "ArrivalExpired",
    status: 409,
  });
  await f.db.update(
    "arrivals",
    {
      deactivated_at: now,
      bound_at: now,
      activation_at: now,
      activation_method: "com.atproto.server.activateAccount",
      completed_at: now,
    },
    eq(f.db.tables.arrivals.operation_id, prepared.operationId),
  );
  await assert.rejects(renew(f, prepared.operationId, prepared.version), {
    error: "ArrivalExpired",
    status: 409,
  });
});

test("cancellation refuses a pending external attempt as a remote obligation", async (t) => {
  const { f, saved } = await preIntent(t);
  const pending = f.ownership.pendingExternal;
  f.ownership.pendingExternal = async () => ({ id: "attempt" });
  await assert.rejects(cancel(f, saved.operation_id, saved.version), {
    code: "OperationRecoveryRequired",
  });
  f.ownership.pendingExternal = pending;
  assert.equal((await stored(f)).arrivals[0].active, 1);
});

test("a superseded, garbage or expired code fails identically with the contract's expired error", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const handoff = {
    operationId: prepared.operationId,
    method: incomingHandoffMethod,
    body: { operation: await plc.signOperation(prepared.handoff, f.source) },
    presentation: await f.credential(),
    arrivalCode: prepared.arrivalCode,
  };
  const admit = (input) => f.composed.admitIncoming(f.request, input);
  const snapshot = async () => ({
    stored: await stored(f),
    replay: await query(f.db, "SELECT * FROM arrival_replay"),
    signed: await query(f.db, "SELECT * FROM arrival_signed_operations"),
    attempts: f.publicationAttempts.length,
  });
  const outcome = async (input) => {
    const before = await snapshot();
    const error = await admit(input).catch((reason) => reason);
    assert.deepEqual(await snapshot(), before);
    return { error: error.error, status: error.status, message: error.message };
  };
  const expired = {
    error: "ArrivalExpired",
    status: 409,
    message: "This arrival code is no longer valid",
  };
  // Exact replay with the current code is idempotent: same facts, no new effects.
  assert.equal((await admit(handoff)).state, "published");
  const settled = await snapshot();
  assert.equal((await admit(handoff)).state, "published");
  assert.deepEqual(await snapshot(), settled);
  assert.equal(f.publicationAttempts.length, 1);
  // Garbage code on an exact replay of an admitted body, before any renewal.
  assert.deepEqual(
    await outcome({ ...handoff, arrivalCode: "garbage" }),
    expired,
  );
  assert.deepEqual(
    await outcome({ ...handoff, arrivalCode: undefined }),
    expired,
  );
  // Garbage code on a body with no admission is the same refusal.
  const invite = await inviteFor(f);
  const creation = {
    operationId: prepared.operationId,
    method: incomingCreationMethod,
    body: { handle, inviteCode: invite },
    presentation: await f.credential(incomingCreationMethod),
    arrivalCode: "garbage",
  };
  assert.deepEqual(await outcome(creation), expired);
  // Superseded code, on both the admitted and the unadmitted body.
  const renewed = await renew(
    f,
    prepared.operationId,
    await versionOf(f, prepared),
  );
  assert.deepEqual(await outcome(handoff), expired);
  assert.deepEqual(
    await outcome({ ...creation, arrivalCode: prepared.arrivalCode }),
    expired,
  );
  // An admitted body re-submitted with the new code can never match again and
  // is told to resume instead of "reload and retry".
  const resubmit = await admit({
    ...handoff,
    arrivalCode: renewed.arrivalCode,
  }).catch((e) => e);
  assert.equal(resubmit.error, "OperationConflict");
  assert.match(resubmit.message, /already admitted; resume/);
  // An expired current code is refused the same way.
  await f.db.update(
    "arrival_code",
    { expires_at: (await stored(f)).code[0].issued_at + 1 },
    eq(f.db.tables.arrival_code.operation_id, prepared.operationId),
  );
  assert.deepEqual(
    await outcome({ ...creation, arrivalCode: renewed.arrivalCode }),
    expired,
  );
});

test("isRecordedAdmissionGeneration accepts only generations that have existed", async () => {
  const { isRecordedAdmissionGeneration: ok } =
    await import("../../dist/src/features/external-migration/arrival-types.js");
  for (const [recorded, current, expected] of [
    [0, 3, false],
    [-1, 3, false],
    [1.5, 3, false],
    [Number.NaN, 3, false],
    [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2, false],
    [4, 3, false],
    [3, 3, true],
    [2, 3, true],
    [1, 3, true],
  ])
    assert.equal(ok(recorded, current), expected, `${recorded}/${current}`);
});

test("a too-high recorded generation is refused by the handoff and creation continuations", async (t) => {
  const f = await fixture(t);
  const prepared = await admitProvisioning(f);
  await f.db.update(
    "arrival_replay",
    { generation: 9 },
    eq(f.db.tables.arrival_replay.operation_id, prepared.operationId),
  );
  await assert.rejects(
    f.composed.continueHandoff(f.request, prepared.operationId),
    { code: "AccountMismatch" },
  );
  await assert.rejects(
    f.composed.continueCreation(f.request, prepared.operationId),
    { code: "AccountMismatch" },
  );
  const attempts = f.publicationAttempts.length;
  await assert.rejects(
    f.composed.reconcileArrival(f.request, prepared.operationId),
  );
  assert.equal(f.publicationAttempts.length, attempts);
  assert.equal(f.backendState.creates, 0);
});
