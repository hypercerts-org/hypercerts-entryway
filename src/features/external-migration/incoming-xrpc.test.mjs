import assert from "node:assert/strict";
import test from "node:test";
import * as plc from "@did-plc/lib";
import { Secp256k1Keypair } from "@atproto/crypto";
import {
  fixture,
  handle,
} from "../../../tests/support/helpers/incoming-arrival-fixture.mjs";
import { incomingHttp } from "../../../tests/support/helpers/incoming-http.mjs";
import { query } from "../../../tests/support/database-fixture.mjs";
import {
  incomingCreationMethod,
  incomingHandoffMethod,
} from "../../../dist/src/features/external-migration/incoming-authorization.js";
import { createInvites } from "../../../dist/src/features/account-registration/invites.mjs";

const submitPath = "/xrpc/com.atproto.identity.submitPlcOperation";
const createPath = "/xrpc/com.atproto.server.createAccount";
const refreshPath = "/xrpc/com.atproto.server.refreshSession";
const activatePath = "/xrpc/com.atproto.server.activateAccount";

async function begin(t, options) {
  const f = await fixture(t);
  const h = await incomingHttp(t, f, options);
  const prepared = await f.prepare();
  const operation = await plc.signOperation(prepared.handoff, f.source);
  return { f, h, prepared, operation };
}
const submit = async ({ f, h, prepared, operation }, overrides = {}) =>
  h.tool(submitPath, {
    code: prepared.arrivalCode,
    jwt: await f.credential(incomingHandoffMethod),
    json: { operation },
    ...overrides,
  });
const invite = async (f) => {
  const invites = await createInvites({
    db: f.db,
    config: f.config,
    accounts: { get: async () => null },
  });
  return (await invites.createInviteCode({ useCount: 1 })).code;
};
const create = async ({ f, h, prepared }, json, overrides = {}) =>
  h.tool(createPath, {
    code: prepared.arrivalCode,
    jwt: await f.credential(incomingCreationMethod),
    json,
    ...overrides,
  });
const rows = (f, table) => query(f.db, `SELECT * FROM ${table}`);
const untouched = async (f) => {
  assert.equal(f.publicationAttempts.length, 0);
  assert.equal((await rows(f, "arrival_replay")).length, 0);
  assert.equal(f.backendState.creates, 0);
};

/** Handoff published through the real route, then an invitation. */
async function published(t, options) {
  const s = await begin(t, options);
  const ok = await submit(s);
  assert.equal(ok.status, 200);
  return s;
}
/** A creation accepted through the real route: tracked credentials issued. */
async function created(t, options = {}) {
  const s = await published(t, options);
  const response = await create(s, {
    handle,
    inviteCode: await invite(s.f),
  });
  assert.equal(response.status, 200, response.text);
  return { ...s, session: response.json };
}

test("submitPlcOperation without the arrival-code header is not incoming", async (t) => {
  const s = await begin(t);
  const response = await submit(s, { code: undefined });
  assert.equal(response.status, 418);
  assert.deepEqual(response.json, { ordinary: "identity.submitPlcOperation" });
  await untouched(s.f);
});

test("submitPlcOperation admits the source-signed handoff with no cookie and publishes only that operation", async (t) => {
  const s = await begin(t);
  // The exact retry is the same body with the same credential (its replay
  // identity), until that credential expires. It is not a second publication.
  const jwt = await s.f.credential(incomingHandoffMethod);
  const response = await submit(s, { jwt });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {});
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(s.f.publicationAttempts.length, 1);
  assert.deepEqual(s.f.publicationAttempts[0], s.operation);
  assert.equal((await rows(s.f, "arrival_replay")).length, 1);
  const retry = await submit(s, { jwt });
  assert.equal(retry.status, 200);
  assert.equal(s.f.publicationAttempts.length, 1);
  assert.equal((await rows(s.f, "arrival_replay")).length, 1);
});

test("a fresh credential for an already admitted body is a conflict, never a second admission", async (t) => {
  const s = await begin(t);
  assert.equal((await submit(s)).status, 200);
  const conflict = await submit(s);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error, "OperationConflict");
  assert.equal(s.f.publicationAttempts.length, 1);
});

test("submitPlcOperation refuses every wrong credential, code, DID, audience, method and shape without effect", async (t) => {
  const s = await begin(t);
  const other = `did:plc:${"b".repeat(24)}`;
  const cases = [
    ["garbage code", { code: "A".repeat(32) }, 409, "ArrivalExpired"],
    ["short code", { code: "x" }, 409, "ArrivalExpired"],
    ["empty code", { code: "" }, 409, "ArrivalExpired"],
    [
      "another DID's credential",
      { jwt: await s.f.credential(incomingHandoffMethod, { iss: other }) },
      409,
      "ArrivalExpired",
    ],
    ["no credential", { jwt: undefined }, 409, "ArrivalExpired"],
    ["malformed bearer", { jwt: "Bearer not-a-jwt" }, 409, "ArrivalExpired"],
    [
      "wrong audience",
      {
        jwt: await s.f.credential(incomingHandoffMethod, {
          aud: "did:web:other.example.test",
        }),
      },
      403,
      "AccountMismatch",
    ],
    [
      "creation-scoped credential",
      { jwt: await s.f.credential(incomingCreationMethod) },
      403,
      "AccountMismatch",
    ],
    [
      "extra body field",
      { json: { operation: s.operation, extra: true } },
      400,
      "InvalidRequest",
    ],
    [
      "operation not an object",
      { json: { operation: "x" } },
      400,
      "InvalidRequest",
    ],
    ["empty body", { json: {} }, 400, "InvalidRequest"],
  ];
  for (const [name, overrides, status, error] of cases) {
    const response = await submit(s, overrides);
    assert.equal(response.status, status, name);
    assert.equal(response.json.error, error, name);
    assert.notEqual(response.status, 418, name);
    assert.equal(response.text.includes(s.prepared.arrivalCode), false, name);
  }
  await untouched(s.f);
});

test("a superseded code fails like an unknown one and the renewed code works", async (t) => {
  const s = await begin(t);
  const renewed = await s.h.browser("/incoming/renew", {
    operationId: s.prepared.operationId,
    expectedVersion: s.prepared.version,
  });
  assert.equal(renewed.status, 200);
  const old = await submit(s);
  const unknown = await submit(s, { code: "B".repeat(32) });
  assert.equal(old.status, 409);
  assert.equal(old.json.error, "ArrivalExpired");
  assert.deepEqual(old.json, unknown.json);
  await untouched(s.f);
  const fresh = await submit(s, { code: renewed.json.arrivalCode });
  assert.equal(fresh.status, 200);
  assert.equal(s.f.publicationAttempts.length, 1);
});

test("an unsigned or wrongly signed handoff is refused before publication", async (t) => {
  const s = await begin(t);
  const stranger = await Secp256k1Keypair.create();
  const forged = await plc.signOperation(s.prepared.handoff, stranger);
  const response = await submit(s, { json: { operation: forged } });
  assert.equal(response.status, 400);
  assert.equal(response.json.error, "InvalidPlcOperation");
  await untouched(s.f);
});

test("createAccount without the header is not incoming", async (t) => {
  const s = await published(t);
  const response = await create(s, { handle }, { code: undefined });
  assert.equal(response.status, 418);
  assert.equal(s.f.backendState.creates, 0);
});

test("createAccount returns tracked credentials only after the binding and family committed", async (t) => {
  const { f, h, prepared, session } = await created(t);
  void h;
  assert.equal(session.did, f.did);
  assert.equal(session.handle, handle);
  assert.equal(session.active, false);
  assert.equal(session.status, "deactivated");
  assert.equal(typeof session.accessJwt, "string");
  assert.equal(typeof session.refreshJwt, "string");
  assert.equal(f.backendState.creates, 1);
  assert.equal(f.backendState.deactivated, true);
  const account = (await rows(f, "accounts"))[0];
  assert.equal(account.status, "provisioning");
  assert.equal((await rows(f, "account_bindings")).length, 1);
  const families = await f.arrivals.readArrivalFamilies(prepared.operationId);
  assert.equal(families.length, 1);
  assert.equal(
    (await f.composed.authorizeArrivalAccess(session.accessJwt)).did,
    f.did,
  );
});

test("a repeated createAccount cannot mint a second family; recovery is the saved-user path", async (t) => {
  const s = await created(t);
  const { f, h, prepared } = s;
  const again = await create(s, {
    handle,
    inviteCode: "ignored-after-admission",
  });
  assert.equal(again.status, 403);
  assert.equal(again.json.error, "AccountMismatch");
  assert.equal(again.text.includes(s.session.accessJwt), false);
  assert.equal(
    (await f.arrivals.readArrivalFamilies(prepared.operationId)).length,
    1,
  );
  assert.equal(f.backendState.creates, 1);
  const recovered = await h.browser("/incoming/recover", {
    operationId: prepared.operationId,
    expectedVersion: (
      await f.arrivals.readArrivalAggregate(
        prepared.operationId,
        f.principal.userId,
      )
    ).arrival.version,
  });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.headers["cache-control"], "no-store");
  assert.notEqual(recovered.json.accessJwt, s.session.accessJwt);
});

test("invitation policy: required without a code is refused before any backend effect", async (t) => {
  const s = await published(t);
  assert.equal(s.f.config.inviteCodeRequired, true);
  const response = await create(s, { handle });
  assert.equal(response.status, 400);
  assert.equal(response.json.error, "InvalidInviteCode");
  assert.equal(s.f.backendState.creates, 0);
});

test("invitation policy: optional allows omission", async (t) => {
  const s = await published(t);
  s.f.config.inviteCodeRequired = false;
  const response = await create(s, { handle });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.did, s.f.did);
});

test("invitation policy: a supplied invalid code is refused even when optional", async (t) => {
  const s = await published(t);
  s.f.config.inviteCodeRequired = false;
  const response = await create(s, { handle, inviteCode: "no-such-code" });
  assert.equal(response.status, 400);
  assert.equal(response.json.error, "InvalidInviteCode");
  assert.equal(s.f.backendState.creates, 0);
});

test("invitation policy: a supplied valid code is consumed once and no retry after cutover repeats it", async (t) => {
  const s = await published(t);
  const code = await invite(s.f);
  const jwt = await s.f.credential(incomingCreationMethod);
  const first = await create(s, { handle, inviteCode: code }, { jwt });
  assert.equal(first.status, 200);
  // After cutover the source key no longer verifies, so even the exact retry
  // cannot be admitted again: no second invitation, family or creation. The
  // saved user recovers through /incoming/recover instead.
  const retry = await create(s, { handle, inviteCode: code }, { jwt });
  assert.equal(retry.status, 403);
  assert.equal(retry.json.error, "AccountMismatch");
  const used = await s.f.db.get("entryway:invites", code);
  assert.equal(used.remaining, 0);
  assert.equal(used.uses.length, 1);
  assert.equal(s.f.backendState.creates, 1);
});

test("createAccount accepts only the supported strict subset", async (t) => {
  const s = await published(t);
  const inviteCode = await invite(s.f);
  for (const body of [
    { handle, inviteCode, password: "correct horse battery" },
    { handle, inviteCode, plcOp: {} },
    { handle, inviteCode, verificationCode: "1" },
    { inviteCode },
    { handle: 7 },
  ]) {
    const response = await create(s, body);
    assert.equal(response.status, 400);
    assert.equal(response.json.error, "InvalidRequest");
  }
  // Valid shape but facts that are not the saved arrival's.
  for (const body of [
    { handle: "someone.else.example.test", inviteCode },
    { handle, did: `did:plc:${"c".repeat(24)}`, inviteCode },
    { handle, email: "another@example.test", inviteCode },
  ]) {
    const response = await create(s, body);
    assert.equal(response.status, 400);
    assert.equal(response.json.error, "InvalidAccount");
  }
  assert.equal(s.f.backendState.creates, 0);
});

test("createAccount refuses wrong credentials without falling through to managed movement", async (t) => {
  const s = await published(t);
  const inviteCode = await invite(s.f);
  const cases = [
    [{ code: "A".repeat(32) }, 409, "ArrivalExpired"],
    [
      { jwt: await s.f.credential(incomingHandoffMethod) },
      403,
      "AccountMismatch",
    ],
    [
      {
        jwt: await s.f.credential(incomingCreationMethod, {
          aud: "did:web:other.example.test",
        }),
      },
      403,
      "AccountMismatch",
    ],
    [
      {
        jwt: await s.f.credential(incomingCreationMethod, {
          iss: `did:plc:${"b".repeat(24)}`,
        }),
      },
      409,
      "ArrivalExpired",
    ],
    [{ jwt: undefined }, 409, "ArrivalExpired"],
  ];
  for (const [overrides, status, error] of cases) {
    const response = await create(s, { handle, inviteCode }, overrides);
    assert.equal(response.status, status);
    assert.equal(response.json.error, error);
  }
  assert.equal(s.f.backendState.creates, 0);
});

test("createAccount before the handoff is canonical stays saved and creates nothing", async (t) => {
  const s = await begin(t);
  const response = await create(s, { handle, inviteCode: await invite(s.f) });
  assert.equal(response.status, 409);
  assert.equal(response.json.error, "OperationRecoveryRequired");
  assert.equal(s.f.backendState.creates, 0);
});

test("refreshSession serves a tracked arrival family and leaves everything else to the ordinary route", async (t) => {
  const { f, h, session } = await created(t);
  const refreshed = await h.call(refreshPath, {
    headers: { authorization: `Bearer ${session.refreshJwt}` },
  });
  assert.equal(refreshed.status, 200, refreshed.text);
  assert.equal(refreshed.headers["cache-control"], "no-store");
  assert.notEqual(refreshed.json.refreshJwt, session.refreshJwt);
  assert.equal(refreshed.json.active, false);
  // Not an arrival family's credential: the ordinary route answers.
  for (const authorization of [
    undefined,
    "Bearer not-a-token",
    `Bearer ${session.accessJwt}`,
  ]) {
    const ordinary = await h.call(refreshPath, {
      headers: authorization ? { authorization } : {},
    });
    assert.equal(ordinary.status, 418);
  }
  // Replaying the rotated-out refresh credential is refused, not served.
  const replay = await h.call(refreshPath, {
    headers: { authorization: `Bearer ${session.refreshJwt}` },
  });
  assert.notEqual(replay.status, 200);
  void f;
});

test("activateAccount activates a pending arrival with its tracked access credential, once", async (t) => {
  const { f, h, session } = await created(t);
  const response = await h.call(activatePath, {
    headers: { authorization: `Bearer ${session.accessJwt}` },
  });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json, {});
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(f.backendState.activations, 1);
  assert.equal((await rows(f, "accounts"))[0].status, "active");
  // A lost response retries into the committed result with no second write.
  const retry = await h.call(activatePath, {
    headers: { authorization: `Bearer ${session.accessJwt}` },
  });
  assert.equal(retry.status, 200);
  assert.equal(f.backendState.activations, 1);
});

test("activateAccount never activates for a source JWT, refresh token, replaced family or unknown bearer", async (t) => {
  const { f, h, prepared, session } = await created(t);
  const sourceJwt = await f.credential(incomingCreationMethod);
  for (const authorization of [
    sourceJwt,
    `Bearer ${session.refreshJwt}`,
    "Bearer not-a-token",
    "Basic Zm9vOmJhcg==",
  ]) {
    const response = await h.call(activatePath, {
      headers: { authorization },
    });
    assert.equal(response.status, 418, authorization.slice(0, 12));
  }
  assert.equal(f.backendState.activations, 0);
  // A replaced family is refused with the ordinary expired-token code.
  const recovered = await h.browser("/incoming/recover", {
    operationId: prepared.operationId,
    expectedVersion: (
      await f.arrivals.readArrivalAggregate(
        prepared.operationId,
        f.principal.userId,
      )
    ).arrival.version,
  });
  assert.equal(recovered.status, 200);
  const stale = await h.call(activatePath, {
    headers: { authorization: `Bearer ${session.accessJwt}` },
  });
  assert.equal(stale.status, 400);
  assert.equal(stale.json.error, "ExpiredToken");
  assert.equal(f.backendState.activations, 0);
  assert.equal((await rows(f, "accounts"))[0].status, "provisioning");
});

test("browser activation needs a fresh code and the exact version, and activates through the same operation", async (t) => {
  const { f, h, prepared } = await created(t);
  const version = (
    await f.arrivals.readArrivalAggregate(
      prepared.operationId,
      f.principal.userId,
    )
  ).arrival.version;
  const input = { operationId: prepared.operationId, expectedVersion: version };
  const stale = await h.browser("/incoming/activate", input, { otp: "stale" });
  assert.equal(stale.status, 403);
  assert.equal(stale.json.error, "ArrivalProofRequired");
  const wrong = await h.browser("/incoming/activate", {
    ...input,
    expectedVersion: version + 1,
  });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.json.error, "OperationConflict");
  assert.equal(f.backendState.activations, 0);
  const noCsrf = await h.browser("/incoming/activate", input, {
    csrf: "forged",
  });
  assert.equal(noCsrf.status, 400);
  const ok = await h.browser("/incoming/activate", input);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.state, "active");
  assert.equal(f.backendState.activations, 1);
  assert.equal((await rows(f, "accounts"))[0].status, "active");
});

test("resume continues the saved steps for the saved user and sends nothing new", async (t) => {
  const { f, h, prepared } = await created(t);
  const effects = [f.backendState.creates, f.backendState.pauses];
  const response = await h.browser("/incoming/resume", {
    operationId: prepared.operationId,
    otp: undefined,
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.state, "pending");
  assert.deepEqual([f.backendState.creates, f.backendState.pauses], effects);
});

test("recover refuses a stale version and a stale proof and leaves the issued family usable", async (t) => {
  const { f, h, prepared, session } = await created(t);
  const version = (
    await f.arrivals.readArrivalAggregate(
      prepared.operationId,
      f.principal.userId,
    )
  ).arrival.version;
  const stale = await h.browser("/incoming/recover", {
    operationId: prepared.operationId,
    expectedVersion: version - 1,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, "OperationConflict");
  const noProof = await h.browser(
    "/incoming/recover",
    { operationId: prepared.operationId, expectedVersion: version },
    { otp: "stale" },
  );
  assert.equal(noProof.status, 403);
  assert.equal(noProof.json.error, "ArrivalProofRequired");
  assert.equal(
    (await f.composed.authorizeArrivalAccess(session.accessJwt)).did,
    f.did,
  );
});

test("only a legacy access token is ever offered to the activation operation", async (t) => {
  const f = await fixture(t);
  const offered = [];
  const real = f.composed.activateArrivalWithCredential;
  f.composed = {
    ...f.composed,
    activateArrivalWithCredential: (bearer) => {
      offered.push(bearer);
      return real(bearer);
    },
  };
  const h = await incomingHttp(t, f);
  const sourceJwt = await f.credential(incomingCreationMethod);
  for (const authorization of [
    sourceJwt,
    "Bearer not-a-token",
    "Bearer a.b.c",
    "Basic Zm9vOmJhcg==",
  ])
    assert.equal(
      (await h.call(activatePath, { headers: { authorization } })).status,
      418,
    );
  assert.deepEqual(offered, []);
});

test("after completion the committed result answers only while the account is active; later reactivation is the ordinary route's", async (t) => {
  const { f, h, session } = await created(t);
  const bearer = { authorization: `Bearer ${session.accessJwt}` };
  assert.equal((await h.call(activatePath, { headers: bearer })).status, 200);
  // Lost final response while still active: the committed result again.
  assert.equal((await h.call(activatePath, { headers: bearer })).status, 200);
  assert.equal(f.backendState.activations, 1);
  // The user later deactivates through the ordinary route.
  const row = await f.storage.getByDid(f.did);
  await f.storage.saveAccount({ ...row, status: "deactivated" });
  const later = await h.call(activatePath, { headers: bearer });
  assert.equal(later.status, 418);
  assert.deepEqual(later.json, { ordinary: "server.activateAccount" });
  assert.equal(f.backendState.activations, 1);
  // The same tracked family's ordinary refresh is also not an arrival's.
  const refreshed = await h.call(refreshPath, {
    headers: { authorization: `Bearer ${session.refreshJwt}` },
  });
  assert.equal(refreshed.status, 418);
});

test("after completion an expired or revoked session of the migrated family is the ordinary route's to refuse", async (t) => {
  const { f, h, session } = await created(t);
  const bearer = { authorization: `Bearer ${session.accessJwt}` };
  assert.equal((await h.call(activatePath, { headers: bearer })).status, 200);
  const ordinary = { ordinary: "server.activateAccount" };
  // Ordinary deactivation revokes the session family in the legacy store only.
  const { sid } = JSON.parse(
    Buffer.from(session.accessJwt.split(".")[1], "base64url").toString(),
  );
  await f.legacy.arrivalSessions.revoke([sid], "test");
  const revoked = await h.call(activatePath, { headers: bearer });
  assert.equal(revoked.status, 418);
  assert.deepEqual(revoked.json, ordinary);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(6 * 60 * 1000);
  const expired = await h.call(activatePath, { headers: bearer });
  assert.equal(expired.status, 418);
  assert.deepEqual(expired.json, ordinary);
  assert.equal(f.backendState.activations, 1);
});

test("after completion an expired session of the migrated family alone falls through", async (t) => {
  const { f, h, session } = await created(t);
  const bearer = { authorization: `Bearer ${session.accessJwt}` };
  assert.equal((await h.call(activatePath, { headers: bearer })).status, 200);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(6 * 60 * 1000);
  const expired = await h.call(activatePath, { headers: bearer });
  assert.equal(expired.status, 418);
  assert.equal(f.backendState.activations, 1);
});

test("a cross-origin post spends no browser budget", async (t) => {
  const f = await fixture(t);
  const h = await incomingHttp(t, f);
  for (let attempt = 0; attempt < 40; attempt++) {
    const refused = await h.browser(
      "/incoming/prepare",
      { did: f.did, handle },
      { origin: "https://evil.example.test" },
    );
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, "InvalidRequest");
  }
  const ok = await h.browser("/incoming/prepare", { did: f.did, handle });
  assert.equal(ok.status, 200);
});

test("the tool request budget answers 429 with the existing code", async (t) => {
  const s = await begin(t);
  let last;
  for (let attempt = 0; attempt < 31; attempt++)
    last = await submit(s, { code: "A".repeat(32) });
  assert.equal(last.status, 429);
  assert.equal(last.json.error, "RateLimitExceeded");
  // The budget is shared with a legitimate request from the same address.
  const legitimate = await submit(s);
  assert.equal(legitimate.status, 429);
  await untouched(s.f);
});

test("a valid code with an invalid credential takes no lease and writes nothing", async (t) => {
  const s = await begin(t);
  let leases = 0;
  const resume = s.f.ownership.resumePending;
  s.f.ownership.resumePending = (...args) => {
    leases++;
    return resume(...args);
  };
  const bad = [
    await s.f.credential(incomingHandoffMethod, {
      aud: "did:web:other.example.test",
    }),
    await s.f.credential(incomingCreationMethod),
    "Bearer a.b.c",
  ];
  for (const jwt of bad) {
    const response = await submit(s, { jwt });
    assert.equal(response.status === 403 || response.status === 409, true);
  }
  assert.equal(leases, 0);
  await untouched(s.f);
  // The legitimate request still takes the lease exactly as before.
  assert.equal((await submit(s)).status, 200);
  assert.equal(leases > 0, true);
});

test("a completed arrival is not reported on a repeat prepare", async (t) => {
  const { f, h, prepared, session } = await created(t);
  const activated = await h.call(activatePath, {
    headers: { authorization: `Bearer ${session.accessJwt}` },
  });
  assert.equal(activated.status, 200);
  const repeat = await h.browser("/incoming/prepare", {
    did: f.did,
    handle,
  });
  assert.equal(repeat.status >= 400, true);
  assert.equal(repeat.json.operationId, undefined);
  assert.equal(repeat.text.includes(prepared.operationId), false);
});

/** A family in the shared legacy store that no arrival tracks: what an
 * ordinary hosted account's session looks like to the incoming handlers. */
async function ordinaryFamily(f) {
  const minted = await f.legacy.arrivalSessions.prepare({
    did: f.did,
    pdsId: f.config.pds[0].id,
  });
  await f.legacy.arrivalSessions.persist(minted);
  return minted;
}
const familyRow = (f, id) => f.db.get("legacy:sessions", id);
const refreshRow = async (f, token) =>
  f.db.get(
    "legacy:refresh",
    JSON.parse(Buffer.from(token.split(".")[1], "base64url")).jti,
  );

test("activateAccount leaves an ordinary credential to the ordinary route in any condition", async (t) => {
  const { f, h } = await created(t);
  const ordinary = await ordinaryFamily(f);
  const call = (jwt) =>
    h.call(activatePath, { headers: { authorization: `Bearer ${jwt}` } });
  assert.equal((await call(ordinary.tokens.accessJwt)).status, 418);
  // Revoked family: the live regression answered 400 instead of the ordinary 401.
  await f.legacy.arrivalSessions.revoke([ordinary.familyId], "test");
  assert.deepEqual((await call(ordinary.tokens.accessJwt)).json, {
    ordinary: "server.activateAccount",
  });
  // Expired access token of a live family.
  const live = await ordinaryFamily(f);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(6 * 60 * 1000);
  assert.deepEqual((await call(live.tokens.accessJwt)).json, {
    ordinary: "server.activateAccount",
  });
  assert.equal(f.backendState.activations, 0);
});

test("activateAccount still refuses a tracked arrival credential whose family is expired", async (t) => {
  const { f, h, session } = await created(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(6 * 60 * 1000);
  const response = await h.call(activatePath, {
    headers: { authorization: `Bearer ${session.accessJwt}` },
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.error, "ExpiredToken");
  assert.equal(f.backendState.activations, 0);
});

test("refreshSession leaves ordinary revoked, expired and replayed refresh tokens untouched for the ordinary route", async (t) => {
  const { f, h } = await created(t);
  const call = (jwt) =>
    h.call(refreshPath, { headers: { authorization: `Bearer ${jwt}` } });
  const ordinaryAnswer = { ordinary: "server.refreshSession" };
  // Replayed: the arrival path performs no replay revocation or rotation.
  const replayed = await ordinaryFamily(f);
  await f.legacy.arrivalSessions.refresh(replayed.tokens.refreshJwt, {
    account: async (family) => ({ did: family.did }),
    details: async () => ({}),
  });
  const before = await familyRow(f, replayed.familyId);
  assert.deepEqual(
    (await call(replayed.tokens.refreshJwt)).json,
    ordinaryAnswer,
  );
  assert.deepEqual(await familyRow(f, replayed.familyId), before);
  assert.equal(
    (await refreshRow(f, replayed.tokens.refreshJwt)).usedAt !== undefined,
    true,
  );
  // Revoked.
  const revoked = await ordinaryFamily(f);
  await f.legacy.arrivalSessions.revoke([revoked.familyId], "test");
  const revokedRow = await familyRow(f, revoked.familyId);
  assert.deepEqual(
    (await call(revoked.tokens.refreshJwt)).json,
    ordinaryAnswer,
  );
  assert.deepEqual(await familyRow(f, revoked.familyId), revokedRow);
  // Expired refresh token (family lifetime elapsed).
  const expired = await ordinaryFamily(f);
  const unused = await refreshRow(f, expired.tokens.refreshJwt);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(91 * 24 * 60 * 60 * 1000);
  assert.deepEqual(
    (await call(expired.tokens.refreshJwt)).json,
    ordinaryAnswer,
  );
  assert.deepEqual(await refreshRow(f, expired.tokens.refreshJwt), unused);
});

test("refreshSession still refuses an expired tracked refresh credential with the expired-token code", async (t) => {
  const { h, session, f } = await created(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(91 * 24 * 60 * 60 * 1000);
  const response = await h.call(refreshPath, {
    headers: { authorization: `Bearer ${session.refreshJwt}` },
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.error, "ExpiredToken");
  void f;
});
