import { Secp256k1MigrationPlcSigner } from "../../../dist/src/plc/signing.js";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServiceJwt } from "@atproto/xrpc-server";
import {
  incomingHandoffMethod,
  incomingCreationMethod,
} from "../../../dist/src/features/external-migration/incoming-authorization.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Secp256k1Keypair } from "@atproto/crypto";
import { cidForCbor } from "@atproto/common";
import * as plc from "@did-plc/lib";
import { createLegacy } from "../../../dist/src/oauth/legacy-credentials.mjs";
import { composeIncomingArrival } from "../../../dist/src/compose-incoming-arrival.mjs";
import { createBrowserFlow } from "../../../dist/src/http/browser-flow.mjs";
import { createOperationOwnership } from "../../../dist/src/accounts/operation-ownership.js";
import { createOperationOwnershipStore } from "../../../dist/src/database/drizzle/operation-ownership.js";
import { createAccountStorage } from "../../../dist/src/database/drizzle/account-storage.js";
import { createArrivalStorage } from "../../../dist/src/database/drizzle/migration-arrival.js";
import { openTestDatabase, verifiedUser, query } from "../database-fixture.mjs";

export const endpoint = "https://destination.example.test";
export const sourceEndpoint = "https://source.example.test";
export const email = "destination@example.test";
export const handle = "destination.example.test";

export async function fixture(t, mode = "modern", mutation = "", fault = "") {
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
    {
      id: "pds2",
      url: "https://other.example.test",
      did: "did:web:other.example.test",
    },
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
      activatePlacedAccount: (subject) =>
        storage.activatePlacedAccount(subject),
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
    get: (value) => storage.getByDid(value),
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
    activations: 0,
    dataWrites: 0,
    calls: [],
    onActivate: null,
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
    backendState.calls.push(parsedUrl.pathname.split("/").at(-1));
    if (parsedUrl.pathname.endsWith("importRepo")) {
      backendState.dataWrites++;
      return Response.json({});
    }
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
    if (
      parsedUrl.pathname.endsWith("updateSubjectStatus") &&
      JSON.parse(options.body).deactivated.applied === false
    ) {
      backendState.activations++;
      assert.equal(options.headers.authorization.startsWith("Basic "), true);
      await backendState.onActivate?.();
      if (backendState.mode === "activation-dropped")
        throw new Error("activation request dropped");
      if (backendState.mode === "activation-rejected")
        return Response.json({ error: "InvalidRequest" }, { status: 400 });
      if (backendState.mode !== "activation-ignored")
        backendState.deactivated = false;
      if (backendState.mode === "activation-lost")
        throw new Error("activation response lost");
      return Response.json({});
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
  const legacy = await createLegacy({ db, config, accounts });
  const composed = await composeIncomingArrival({
    db,
    arrivals,
    config,
    accounts,
    legacy,
    authentication,
    browserFlow,
  });
  return {
    get db() {
      return db;
    },
    legacy,
    storage,
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

export async function admitProvisioning(f, interruptHandoff = false) {
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
    await import("../../../dist/src/features/account-registration/invites.mjs");
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
