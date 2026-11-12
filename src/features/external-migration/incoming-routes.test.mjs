import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../../../tests/support/helpers/incoming-arrival-fixture.mjs";
import { incomingHttp } from "../../../tests/support/helpers/incoming-http.mjs";
import { query } from "../../../tests/support/database-fixture.mjs";
import { DomainError } from "../../../dist/src/accounts/errors.js";

const prepareBody = (f) => ({ did: f.did, handle: "destination.example.test" });
const secretFree = (text, secrets) => {
  for (const secret of secrets) assert.equal(text.includes(secret), false);
};

test("prepare is strict, proof-gated, no-store and returns the code once", async (t) => {
  const f = await fixture(t);
  const h = await incomingHttp(t, f);
  const body = { handle: "destination.example.test" };
  // Unknown fields, a missing DID or a missing proof field are the same stable 400.
  for (const bad of [
    { ...prepareBody(f), email: "someone@example.test" },
    { ...prepareBody(f), userId: "destination-user" },
    body,
  ]) {
    const refused = await h.browser("/incoming/prepare", bad);
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, "InvalidRequest");
  }
  // A body without the proof fields never reaches a code check.
  const noCsrf = await h.call("/incoming/prepare", {
    headers: { origin: f.config.issuer },
    json: { ...prepareBody(f), otp: "fresh-otp" },
  });
  assert.equal(noCsrf.status, 400);
  assert.equal(f.verifications(), 0);
  // Cross-origin and wrong-CSRF requests are refused before any code is checked.
  const crossOrigin = await h.browser("/incoming/prepare", prepareBody(f), {
    origin: "https://evil.example.test",
  });
  assert.equal(crossOrigin.status, 400);
  assert.equal(crossOrigin.json.error, "InvalidRequest");
  const wrongCsrf = await h.browser("/incoming/prepare", prepareBody(f), {
    csrf: "forged",
  });
  assert.equal(wrongCsrf.status, 400);
  assert.equal(f.verifications(), 0);
  const stale = await h.browser("/incoming/prepare", prepareBody(f), {
    otp: "stale",
  });
  assert.equal(stale.status, 403);
  assert.equal(stale.json.error, "ArrivalProofRequired");
  assert.equal(f.reservations(), 0);
  const ok = await h.browser("/incoming/prepare", prepareBody(f));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.equal(typeof ok.json.arrivalCode, "string");
  assert.equal(typeof ok.json.operationId, "string");
  assert.equal(ok.json.version >= 1, true);
  assert.equal(ok.json.entrywayDid, f.config.serviceDid);
  // Only the hash is stored.
  const stored = await query(f.db, "SELECT * FROM arrival_code");
  assert.equal(JSON.stringify(stored).includes(ok.json.arrivalCode), false);
  // Replaying cannot reproduce the code: it is a stable recovery refusal.
  const replay = await h.browser("/incoming/prepare", prepareBody(f));
  assert.equal(replay.status, 409);
  assert.equal(replay.json.error, "OperationRecoveryRequired");
  secretFree(replay.text, [ok.json.arrivalCode]);
});

test("a form post renders the one-time page, no-store, and failures render stable pages", async (t) => {
  const f = await fixture(t);
  const h = await incomingHttp(t, f);
  const ok = await h.call("/incoming/prepare", {
    headers: { origin: f.config.issuer },
    form: {
      csrf: f.request.body.csrf,
      otp: "fresh-otp",
      ...prepareBody(f),
    },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.match(ok.headers["content-type"], /text\/html/);
  assert.match(ok.text, /shown once/);
  const refused = await h.call("/incoming/prepare", {
    headers: { origin: f.config.issuer },
    form: { csrf: f.request.body.csrf, otp: "stale", ...prepareBody(f) },
  });
  assert.equal(refused.status, 403);
  assert.match(refused.text, /Verify the destination email again/);
});

test("renew is proof-gated, version-checked, no-store and returns a replacement code", async (t) => {
  const f = await fixture(t);
  const h = await incomingHttp(t, f);
  const prepared = (await h.browser("/incoming/prepare", prepareBody(f))).json;
  const stale = await h.browser(
    "/incoming/renew",
    { operationId: prepared.operationId, expectedVersion: prepared.version },
    { otp: "stale" },
  );
  assert.equal(stale.status, 403);
  assert.equal(stale.json.error, "ArrivalProofRequired");
  const wrongVersion = await h.browser("/incoming/renew", {
    operationId: prepared.operationId,
    expectedVersion: prepared.version + 5,
  });
  assert.equal(wrongVersion.status, 409);
  assert.equal(wrongVersion.json.error, "OperationConflict");
  const renewed = await h.browser("/incoming/renew", {
    operationId: prepared.operationId,
    expectedVersion: prepared.version,
  });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.headers["cache-control"], "no-store");
  assert.notEqual(renewed.json.arrivalCode, prepared.arrivalCode);
  assert.equal(renewed.json.version > prepared.version, true);
  assert.deepEqual(Object.keys(renewed.json).sort(), [
    "arrivalCode",
    "expiresAt",
    "operationId",
    "version",
  ]);
});

test("a wrong owner and an unknown operation are the same 404 on every saved-user route", async (t) => {
  const f = await fixture(t);
  const h = await incomingHttp(t, f);
  const prepared = (await h.browser("/incoming/prepare", prepareBody(f))).json;
  const results = [];
  for (const [path, extra] of [
    ["/incoming/renew", { expectedVersion: prepared.version }],
    ["/incoming/cancel", { expectedVersion: prepared.version }],
    ["/incoming/recover", { expectedVersion: prepared.version }],
    ["/incoming/activate", { expectedVersion: prepared.version }],
    ["/incoming/resume", { otp: undefined }],
  ]) {
    const unknown = await h.browser(path, {
      operationId: "no-such-operation",
      ...extra,
    });
    f.principal.userId = "someone-else";
    const stranger = await h.browser(path, {
      operationId: prepared.operationId,
      ...extra,
    });
    f.principal.userId = "destination-user";
    assert.equal(unknown.status, 404, path);
    assert.equal(unknown.json.error, "AccountNotFound", path);
    assert.equal(stranger.status, 404, path);
    assert.deepEqual(stranger.json, unknown.json, path);
    results.push(path);
  }
  assert.equal(results.length, 5);
  // The status page gives the same answer.
  const unknownPage = await h.call("/incoming?operationId=nope", {
    method: "GET",
  });
  f.principal.userId = "someone-else";
  const strangerPage = await h.call(
    `/incoming?operationId=${prepared.operationId}`,
    { method: "GET" },
  );
  f.principal.userId = "destination-user";
  assert.equal(unknownPage.status, 404);
  assert.equal(strangerPage.status, 404);
  assert.equal(strangerPage.text, unknownPage.text);
});

test("cancel of a prepared arrival is the stable recovery refusal, never a release", async (t) => {
  const f = await fixture(t);
  const h = await incomingHttp(t, f);
  const prepared = (await h.browser("/incoming/prepare", prepareBody(f))).json;
  const refused = await h.browser("/incoming/cancel", {
    operationId: prepared.operationId,
    expectedVersion: prepared.version,
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, "OperationRecoveryRequired");
  const rows = await query(f.db, "SELECT cancelled_at FROM arrivals");
  assert.equal(rows[0].cancelled_at, null);
});

test("recover and activate refuse before binding and spend no backend effect", async (t) => {
  const f = await fixture(t);
  const h = await incomingHttp(t, f);
  const prepared = (await h.browser("/incoming/prepare", prepareBody(f))).json;
  const input = {
    operationId: prepared.operationId,
    expectedVersion: prepared.version,
  };
  for (const path of ["/incoming/recover", "/incoming/activate"]) {
    const refused = await h.browser(path, input);
    assert.equal(refused.status, 409, path);
    assert.equal(refused.json.error, "OperationConflict", path);
  }
  assert.equal(f.backendState.activations, 0);
  assert.equal(f.backendState.creates, 0);
});

test("budgets: the browser IP budget answers 429 with the existing code", async (t) => {
  const f = await fixture(t);
  const h = await incomingHttp(t, f);
  let last;
  for (let attempt = 0; attempt < 31; attempt++)
    last = await h.browser("/incoming/prepare", { bad: true });
  assert.equal(last.status, 429);
  assert.equal(last.json.error, "RateLimitExceeded");
});

test("the status page shows only the saved user's facts and honest wording", async (t) => {
  const f = await fixture(t);
  const h = await incomingHttp(t, f);
  const prepared = (await h.browser("/incoming/prepare", prepareBody(f))).json;
  const start = await h.call("/incoming", { method: "GET" });
  assert.equal(start.status, 200);
  assert.equal(start.headers["cache-control"], "no-store");
  const detail = await h.call(
    `/incoming?operationId=${encodeURIComponent(prepared.operationId)}`,
    { method: "GET" },
  );
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Prepared/);
  secretFree(detail.text, [prepared.arrivalCode, f.config.betterAuthSecret]);
  // A non-string selector is a stable 400, not a lookup.
  const array = await h.call("/incoming?operationId=a&operationId=b", {
    method: "GET",
  });
  assert.equal(array.status, 400);
});

test("code sends a fresh sign-in code only to the verified browser owner's own email, within budget", async (t) => {
  const f = await fixture(t);
  const h = await incomingHttp(t, f);
  const noCsrf = await h.call("/incoming/code", {
    headers: { origin: f.config.issuer },
    json: { csrf: "forged" },
  });
  assert.equal(noCsrf.status, 400);
  // An email or any other field is never accepted.
  const extra = await h.call("/incoming/code", {
    headers: { origin: f.config.issuer },
    json: { csrf: f.request.body.csrf, email: "someone@example.test" },
  });
  assert.equal(extra.status, 400);
  assert.equal(f.sentCodes.length, 0);
  const sent = [];
  for (let attempt = 0; attempt < 6; attempt++)
    sent.push(
      await h.call("/incoming/code", {
        headers: { origin: f.config.issuer },
        json: { csrf: f.request.body.csrf },
      }),
    );
  assert.deepEqual(
    sent.map((response) => response.status),
    [200, 200, 200, 200, 200, 429],
  );
  assert.equal(sent[0].headers["cache-control"], "no-store");
  assert.deepEqual(new Set(f.sentCodes), new Set([f.principal.email]));
  assert.equal(sent[5].json.error, "RateLimitExceeded");
});

test("a repeat prepare by the same saved user returns their own operation ID and nothing else", async (t) => {
  const f = await fixture(t);
  const h = await incomingHttp(t, f);
  const first = (await h.browser("/incoming/prepare", prepareBody(f))).json;
  const snapshot = async () =>
    JSON.stringify([
      await query(f.db, "SELECT * FROM arrivals"),
      await query(f.db, "SELECT * FROM arrival_code"),
      await query(f.db, "SELECT * FROM arrival_reservations"),
    ]);
  const before = await snapshot();
  const reservations = f.reservations();
  const repeat = await h.browser("/incoming/prepare", prepareBody(f));
  // Same status and code as the existing refusal, with the ID added.
  assert.equal(repeat.status, 409);
  assert.equal(repeat.json.error, "OperationRecoveryRequired");
  assert.equal(repeat.headers["cache-control"], "no-store");
  assert.equal(repeat.json.operationId, first.operationId);
  assert.equal(repeat.json.version, first.version);
  assert.equal(repeat.text.includes(first.arrivalCode), false);
  assert.equal(await snapshot(), before);
  assert.equal(f.reservations(), reservations);
  // The returned ID works for renew.
  const renewed = await h.browser("/incoming/renew", {
    operationId: repeat.json.operationId,
    expectedVersion: repeat.json.version,
  });
  assert.equal(renewed.status, 200);
  assert.notEqual(renewed.json.arrivalCode, first.arrivalCode);
  // The HTML page shows the ID honestly and still no code.
  const form = await h.call("/incoming/prepare", {
    headers: { origin: f.config.issuer },
    form: {
      csrf: f.request.body.csrf,
      otp: "fresh-otp",
      ...prepareBody(f),
    },
  });
  assert.equal(form.status, 409);
  assert.match(form.text, /already have an incoming migration/);
  assert.equal(form.text.includes(first.operationId), true);
  assert.equal(form.text.includes(renewed.json.arrivalCode), false);
});

test("a repeat prepare gets no ID without the full proof, or for another user's arrival", async (t) => {
  const f = await fixture(t);
  const h = await incomingHttp(t, f);
  const first = (await h.browser("/incoming/prepare", prepareBody(f))).json;
  const refusals = [
    await h.browser("/incoming/prepare", prepareBody(f), { otp: "stale" }),
    await h.browser("/incoming/prepare", prepareBody(f), { csrf: "forged" }),
    await h.browser("/incoming/prepare", prepareBody(f), {
      origin: "https://evil.example.test",
    }),
    await h.call("/incoming/prepare", {
      headers: { origin: f.config.issuer },
      json: { csrf: f.request.body.csrf, ...prepareBody(f) },
    }),
  ];
  for (const refusal of refusals) {
    assert.equal(refusal.json.operationId, undefined);
    assert.equal(refusal.text.includes(first.operationId), false);
  }
  // Another verified user repeating for the same DID: today's refusal, no ID.
  f.principal.userId = "someone-else";
  const stranger = await h.browser("/incoming/prepare", prepareBody(f));
  f.principal.userId = "destination-user";
  assert.equal(stranger.status >= 400 && stranger.status < 500, true);
  assert.equal(stranger.json.operationId, undefined);
  assert.equal(stranger.json.version, undefined);
  assert.equal(stranger.text.includes(first.operationId), false);
});

test("the existing ID is attached only to the repeat-prepare refusal of an arrival that can still be acted on", async (t) => {
  const f = await fixture(t);
  const h = await incomingHttp(t, f);
  const first = (await h.browser("/incoming/prepare", prepareBody(f))).json;
  const repeat = () => h.browser("/incoming/prepare", prepareBody(f));
  // An unrelated refusal or a server failure never carries the ID.
  const createArrival = f.arrivals.createArrival;
  f.arrivals.createArrival = async () => {
    throw new DomainError(
      "OperationPending",
      409,
      "Another operation is pending",
    );
  };
  const pendingRefusal = await repeat();
  assert.equal(pendingRefusal.status, 409);
  assert.equal(pendingRefusal.json.error, "OperationPending");
  assert.equal(pendingRefusal.json.operationId, undefined);
  f.arrivals.createArrival = async () => {
    throw new Error("boom");
  };
  const failure = await repeat();
  assert.equal(failure.status, 500);
  assert.equal(failure.text.includes(first.operationId), false);
  f.arrivals.createArrival = createArrival;
  // If the lookup itself fails, the original refusal is still what the caller sees.
  const read = f.arrivals.readArrivalAccess;
  f.arrivals.readArrivalAccess = async () => {
    throw new Error("lookup failed");
  };
  const lookupFailed = await repeat();
  f.arrivals.readArrivalAccess = read;
  assert.equal(lookupFailed.status, 409);
  assert.equal(lookupFailed.json.error, "OperationRecoveryRequired");
  assert.equal(lookupFailed.json.operationId, undefined);
  // A cancelled arrival is not reported.
  await query(
    f.db,
    "UPDATE arrivals SET cancelled_at = 1, active = 0, did_root = NULL",
    [],
    "run",
  );
  const cancelled = await repeat();
  assert.equal(cancelled.json.operationId, undefined);
  assert.equal(cancelled.text.includes(first.operationId), false);
});
