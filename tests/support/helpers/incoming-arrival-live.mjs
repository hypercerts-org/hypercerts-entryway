import { createLegacy } from "../../../dist/src/oauth/legacy-credentials.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createOperationOwnershipStore } from "../../../dist/src/database/drizzle/operation-ownership.js";
import { randomUUID } from "node:crypto";
import { cidForCbor } from "@atproto/common";
import { openDatabase } from "../../../dist/src/database/connection.js";
import { createAccounts } from "../../../dist/src/compose-accounts.mjs";
import { createArrivalStorage } from "../../../dist/src/database/drizzle/migration-arrival.js";
import { composeIncomingArrival } from "../../../dist/src/compose-incoming-arrival.mjs";
import { createBetterAuthAuthentication } from "../../../dist/src/authentication/better-auth.mjs";
import { createBrowserFlow } from "../../../dist/src/http/browser-flow.mjs";
import { createMailFeature } from "../../../dist/src/mail/create-mail.js";
import { createMailOutbox } from "../../../dist/src/database/drizzle/mail-outbox.js";
import { createSmtpMailTransport } from "../../../dist/src/mail/smtp.js";
import { waitForMailpitCode } from "./mailpit.mjs";
import { waitForStockPlcMessage } from "./stock-plc-mailpit.mjs";

export async function discardAppliedArrivalResponse({
  fault,
  method,
  response,
  discarded,
}) {
  const matchesFault =
    (fault === "creation-lost" &&
      method === "com.atproto.server.createAccount") ||
    (fault === "pause-lost" &&
      method === "com.atproto.admin.updateSubjectStatus");
  if (discarded || !response.ok || !matchesFault) return false;
  await response.arrayBuffer();
  return true;
}

// Contributors qualifying dormant composition use normal proof producers here;
// no identity, arrival, or authentication rows are inserted by the harness.
export async function qualifyIncomingArrival(t, fault = "normal") {
  const access = JSON.parse(
    await readFile(process.env.INCOMING_ACCESS_PATH, "utf8"),
  );
  assert.equal(access.project, process.env.INCOMING_PROJECT);
  const config = JSON.parse(
    await readFile(process.env.SERVICE_CONFIG_PATH, "utf8"),
  );
  const resume = process.env.INCOMING_RECOVERY === "1";
  const receiptPath = `/app/artifacts/incoming-live-recovery-${fault}.json`;
  const receipt = resume
    ? JSON.parse(await readFile(receiptPath, "utf8"))
    : null;
  const unique = receipt?.unique ?? randomUUID().replaceAll("-", "");
  const state = `/app/artifacts/incoming-live-${unique}`;
  if (!resume) await mkdir(state, { mode: 0o700 });
  const db = await openDatabase({
    backend: "sqlite",
    path: `${state}/authority.sqlite`,
  });
  t.after(() => db.close());
  const mail = createMailFeature({
    outbox: createMailOutbox(db),
    transport: createSmtpMailTransport({ host: "mail-capture", port: 2525 }),
  });
  const authentication = await createBetterAuthAuthentication({
    db,
    config,
    mail,
  });
  const email = `arrival-${unique}@example.com`;
  const request = receipt?.request ?? {
    headers: { origin: config.issuer },
    body: {},
  };
  async function freshCode() {
    const since = Date.now();
    await authentication.sendSignInCode(email);
    return (
      await waitForMailpitCode({
        recipient: email,
        since,
        baseUrl: access.mailpitUrl,
      })
    ).code;
  }
  if (!resume) {
    const login = await authentication.verifySignInCode({
      email,
      otp: await freshCode(),
    });
    assert.equal(login.ok, true);
    const cookies = [];
    login.commitCookies({
      append: (_name, value) => cookies.push(value.split(";")[0]),
    });
    request.headers.cookie = cookies.join("; ");
  }
  const principal = await authentication.requireSession(request);
  assert.equal(principal.emailVerified, true);
  const browserFlow = createBrowserFlow({
    db,
    config,
    provider: { deviceManager: { load: async () => ({ deviceId: unique }) } },
  });
  request.body.csrf = (await browserFlow.loadBrowser(request)).csrf;
  const accounts = await createAccounts({ db, config });
  const storage = accounts.storage;
  const arrivals = createArrivalStorage(db, config.pds, {
    readAccount: (did) => storage.getByDid(did),
    readBinding: (did) => storage.getVerifiedBinding(did),
    reserveEmailClaim: (...args) => storage.reserveEmail(...args),
    reserveHandleClaim: (...args) => storage.reserveHandle(...args),
    recordSavedUserBinding: (did, userId) =>
      db.insert(
        "account_bindings",
        { did, user_id: userId },
        { ignoreConflict: true },
      ),
    activatePlacedAccount: (subject) => storage.activatePlacedAccount(subject),
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
  const composed = await composeIncomingArrival({
    db,
    arrivals,
    config,
    accounts,
    legacy: await createLegacy({ db, config, accounts }),
    authentication,
    browserFlow,
  });
  if (resume) {
    assert.equal(receipt.project, access.project);
    assert.ok(process.env.INCOMING_DISPATCHER_EXIT_REFERENCE);
    assert.ok(process.env.INCOMING_UPSTREAM_DRAIN_REFERENCE);
    const store = createOperationOwnershipStore(db);
    const attempt = await store.pendingExternal(`arrival:${receipt.did}`);
    assert.ok(attempt);
    await store.approveRecovery({
      operationId: attempt.operationId,
      externalAttemptId: attempt.id,
      executionAttemptId: attempt.executionAttemptId,
      target: attempt.target,
      dispatcherIsolationReference:
        process.env.INCOMING_DISPATCHER_EXIT_REFERENCE,
      upstreamDrainReference: process.env.INCOMING_UPSTREAM_DRAIN_REFERENCE,
      action: "observe",
    });
    let writes = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (/createAccount|reserveSigningKey/.test(new URL(url).pathname))
        writes++;
      return originalFetch(url, options);
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    assert.equal(
      (await composed.reconcileArrival(request, receipt.operationId)).state,
      "pending",
    );
    assert.ok(await storage.getVerifiedBinding(receipt.did));
    assert.equal(writes, 0);
    const aggregate = await arrivals.readArrivalAggregate(
      receipt.operationId,
      principal.userId,
    );
    assert.equal(
      String(await cidForCbor(await accounts.plcClient.getLastOp(receipt.did))),
      aggregate.signedOperations.find(
        (item) => item.kind === "destination-move",
      ).cid,
    );
    assert.equal((await arrivals.readArrivalAccess(receipt.did)).bound, true);
    t.diagnostic(
      JSON.stringify({
        fault,
        approvedObserveRecovery: true,
        boundPending: true,
        duplicateCreation: false,
        newReservation: false,
      }),
    );
    return;
  }
  async function rpc(origin, method, { token, body, params } = {}) {
    const url = new URL(`/xrpc/${method}`, origin);
    for (const [key, value] of Object.entries(params ?? {}))
      url.searchParams.set(key, value);
    const emptyProcedure =
      method === "com.atproto.identity.requestPlcOperationSignature";
    const response = await fetch(url, {
      method: emptyProcedure || body !== undefined ? "POST" : "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`Live ${method} failed status ${response.status}`);
    const text = await response.text();
    return text.trim() ? JSON.parse(text) : {};
  }
  const description = await rpc(
    access.sourceUrl,
    "com.atproto.server.describeServer",
  );
  const sourceHandle = `s${unique.slice(0, 16)}${description.availableUserDomains[0]}`;
  const destinationHandle = `d${unique.slice(0, 16)}${config.handleDomains[0]}`;
  assert.notEqual(sourceHandle, destinationHandle);
  const sourceEmail = `source-${unique}@example.com`;
  const source = await rpc(
    access.sourceUrl,
    "com.atproto.server.createAccount",
    {
      body: {
        email: sourceEmail,
        password: `Live-${randomUUID()}!`,
        handle: sourceHandle,
      },
    },
  );
  const prepared = await composed.prepareArrival(request, await freshCode(), {
    did: source.did,
    handle: destinationHandle,
  });
  assert.equal(prepared.sourceEndpoint, access.sourceUrl);
  const saved = await arrivals.readArrival(
    prepared.operationId,
    principal.userId,
  );
  assert.equal(saved.source.alsoKnownAs[0], `at://${sourceHandle}`);
  const credential = async (method) =>
    `Bearer ${(await rpc(access.sourceUrl, "com.atproto.server.getServiceAuth", { token: source.accessJwt, params: { aud: config.serviceDid, lxm: method } })).token}`;
  // Obtain both source-signed credentials before destination key cutover.
  const handoffMethod = "com.atproto.identity.submitPlcOperation";
  const creationMethod = "com.atproto.server.createAccount";
  const handoffCredential = await credential(handoffMethod);
  const creationCredential = await credential(creationMethod);
  const since = Date.now();
  await rpc(
    access.sourceUrl,
    "com.atproto.identity.requestPlcOperationSignature",
    { token: source.accessJwt },
  );
  const confirmation = await waitForStockPlcMessage({
    recipient: sourceEmail,
    since,
    excludeIds: [],
    baseUrl: access.mailpitUrl,
    signal: t.signal,
  });
  const signed = await rpc(
    access.sourceUrl,
    "com.atproto.identity.signPlcOperation",
    {
      token: source.accessJwt,
      body: {
        token: confirmation.token,
        rotationKeys: prepared.handoff.rotationKeys,
        alsoKnownAs: prepared.handoff.alsoKnownAs,
        verificationMethods: prepared.handoff.verificationMethods,
        services: prepared.handoff.services,
      },
    },
  );
  const admit = (method, body, presentation) =>
    composed.admitIncoming(request, {
      operationId: prepared.operationId,
      method,
      body,
      presentation,
      arrivalCode: prepared.arrivalCode,
    });
  await admit(
    handoffMethod,
    { operation: signed.operation },
    handoffCredential,
  );
  await composed.continueHandoff(request, prepared.operationId);
  await admit(
    creationMethod,
    { handle: destinationHandle },
    creationCredential,
  );
  const calls = [];
  const originalFetch = globalThis.fetch;
  let discarded = false;
  globalThis.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    const method = new URL(url).pathname.split("/").at(-1);
    if (String(url).startsWith(prepared.destinationEndpoint)) {
      const binding = await storage.getVerifiedBinding(source.did);
      calls.push({ method, status: response.status, bound: Boolean(binding) });
      if (
        await discardAppliedArrivalResponse({
          fault,
          method,
          response,
          discarded,
        })
      ) {
        discarded = true;
        throw new Error("Controlled applied response discard");
      }
    }
    return response;
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  if (fault !== "normal") {
    await assert.rejects(
      composed.continueCreation(request, prepared.operationId),
    );
    assert.equal(discarded, true);
    assert.equal(await storage.getVerifiedBinding(source.did), null);
    const effectCount = calls.filter((item) =>
      /createAccount|updateSubjectStatus/.test(item.method),
    ).length;
    await assert.rejects(
      composed.reconcileArrival(request, prepared.operationId),
      { code: "OperationRecoveryRequired" },
    );
    assert.equal(
      calls.filter((item) =>
        /createAccount|updateSubjectStatus/.test(item.method),
      ).length,
      effectCount,
    );
    await writeFile(
      receiptPath,
      JSON.stringify({
        project: access.project,
        unique,
        request,
        did: source.did,
        operationId: prepared.operationId,
      }),
      { mode: 0o600 },
    );
    t.diagnostic(
      JSON.stringify({
        fault,
        appliedResponseDiscarded: true,
        unbound: true,
        automaticRetryBlocked: true,
        operatorRecovery: "pending-owned-worker-stop-and-upstream-drain",
      }),
    );
    return;
  }
  const result = await composed.continueCreation(request, prepared.operationId);
  assert.equal(result.state, "pending");
  const aggregate = await arrivals.readArrivalAggregate(
    prepared.operationId,
    principal.userId,
  );
  const head = await accounts.plcClient.getLastOp(source.did);
  assert.equal(
    String(await cidForCbor(head)),
    aggregate.signedOperations.find((item) => item.kind === "destination-move")
      .cid,
  );
  assert.ok(await storage.getVerifiedBinding(source.did));
  assert.ok(
    calls.some(
      (item) =>
        item.method === "com.atproto.admin.getAccountInfo" &&
        item.status === 200 &&
        !item.bound,
    ),
  );
  assert.ok(
    calls.some(
      (item) =>
        item.method === "com.atproto.admin.updateSubjectStatus" &&
        item.status === 200 &&
        !item.bound,
    ),
  );
  const before = calls.filter((item) =>
    /createAccount|reserveSigningKey/.test(item.method),
  ).length;
  await composed.continueCreation(request, prepared.operationId);
  assert.equal(
    calls.filter((item) => /createAccount|reserveSigningKey/.test(item.method))
      .length,
    before,
  );
  const target = config.pds.find(
    (item) => item.url === prepared.destinationEndpoint,
  );
  const status = await originalFetch(
    new URL(
      `/xrpc/com.atproto.admin.getAccountInfo?did=${encodeURIComponent(source.did)}`,
      target.url,
    ),
    {
      headers: {
        authorization: `Basic ${Buffer.from(`admin:${target.adminPassword}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  assert.equal(status.status, 200);
  assert.ok((await status.json()).deactivatedAt);
  t.diagnostic(
    JSON.stringify({
      source: access.sourceUrl,
      target: target.url,
      sourceExportOrigin: prepared.sourceEndpoint,
      adminBeforeBind: calls.filter((item) =>
        item.method.startsWith("com.atproto.admin."),
      ),
      inactive: true,
      boundPending: true,
    }),
  );
}
