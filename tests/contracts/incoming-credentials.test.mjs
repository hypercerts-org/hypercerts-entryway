import assert from "node:assert/strict";
import test from "node:test";
import { decodeJwt, decodeProtectedHeader, importJWK, SignJWT } from "jose";
import {
  fixture,
  admitProvisioning,
} from "../support/helpers/incoming-arrival-fixture.mjs";
import { hashPassword } from "../../dist/src/authentication/password-crypto.mjs";
import { createAccountPrimitives } from "../../dist/src/accounts/primitives.mjs";
import {
  verifiedUser,
  failureTrigger,
  removeFailureTrigger,
  hasFailure,
  query,
} from "../support/database-fixture.mjs";

const codeOf = (error) => error.code ?? error.error;
const hasCode = (code) => (error) => codeOf(error) === code;
const pdsDid = "did:web:destination.example.test";

async function bound(t) {
  const f = await fixture(t);
  const prepared = await admitProvisioning(f);
  f.arrivalCode = prepared.arrivalCode;
  const result = await f.composed.continueCreation(
    f.request,
    prepared.operationId,
  );
  assert.equal(result.state, "pending");
  return { f, op: prepared.operationId };
}
const version = async (f, op) =>
  (await f.arrivals.readArrivalAggregate(op, f.principal.userId)).arrival
    .version;
const issue = async (f, op, expected) =>
  f.composed.issueArrivalSession(
    f.request,
    op,
    expected ?? (await version(f, op)),
  );
const recover = async (f, op, expected, otp = "fresh-otp") =>
  f.composed.recoverArrivalSession(f.request, otp, {
    operationId: op,
    expectedVersion: expected ?? (await version(f, op)),
  });
const families = (f) =>
  query(f.db, "SELECT family_id, revoked_at FROM arrival_families");
const sessions = (f) =>
  query(
    f.db,
    "SELECT value FROM key_value_state WHERE namespace = 'legacy:sessions'",
  );
const refreshRows = (f) =>
  query(
    f.db,
    "SELECT key FROM key_value_state WHERE namespace = 'legacy:refresh'",
  );
const sign = async (f, claims, typ = "at+jwt") =>
  new SignJWT(claims.payload)
    .setProtectedHeader({ typ, alg: "ES256K" })
    .setIssuer(f.config.issuer)
    .setSubject(claims.sub)
    .setAudience(claims.aud)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setJti(claims.jti ?? "j".repeat(43))
    .sign(await importJWK(f.config.jwtJwk, "ES256K"));
const remoteEffects = (f) => ({
  creates: f.backendState.creates,
  pauses: f.backendState.pauses,
  activations: f.backendState.activations,
  reservations: f.reservations(),
  publications: f.publicationAttempts.length,
  credentials: f.credentialsIssued(),
});

test("issuance returns exact tracked claims only after the committed association", async (t) => {
  const { f, op } = await bound(t);
  const before = await version(f, op);
  const session = await issue(f, op);
  const access = decodeJwt(session.accessJwt);
  const refresh = decodeJwt(session.refreshJwt);
  assert.equal(decodeProtectedHeader(session.accessJwt).typ, "at+jwt");
  assert.equal(decodeProtectedHeader(session.refreshJwt).typ, "refresh+jwt");
  assert.equal(access.sub, f.did);
  assert.equal(access.aud, pdsDid);
  assert.equal(access.scope, "com.atproto.access");
  assert.equal(access.iss, f.config.issuer);
  assert.equal(refresh.sub, f.did);
  assert.equal(refresh.aud, f.config.serviceDid);
  assert.equal(refresh.scope, "com.atproto.refresh");
  assert.equal(access.sid, refresh.sid);
  assert.equal(session.did, f.did);
  assert.equal(session.active, false);
  assert.equal(session.status, "deactivated");
  assert.equal(session.emailConfirmed, true);
  const rows = await families(f);
  assert.deepEqual(
    rows.map((row) => row.family_id),
    [access.sid],
  );
  assert.equal(rows[0].revoked_at, null);
  assert.equal(await version(f, op), before + 1);
  assert.equal((await sessions(f)).length, 1);
});

test("no credentials before provisioning, deactivation and binding", async (t) => {
  const f = await fixture(t);
  const prepared = await admitProvisioning(f);
  const op = prepared.operationId;
  await assert.rejects(issue(f, op), hasCode("OperationConflict"));
  await assert.rejects(recover(f, op), hasCode("OperationConflict"));
  assert.equal((await families(f)).length, 0);
  assert.equal((await sessions(f)).length, 0);
});

test("wrong owner, unknown operation, stale version, repeated issuance and wrong host are refused", async (t) => {
  const { f, op } = await bound(t);
  const current = await version(f, op);
  const unknown = await issue(f, "no-such-operation", 1).catch((e) => e);
  f.principal.userId = "someone-else";
  const wrongOwner = await issue(f, op, current).catch((e) => e);
  f.principal.userId = "destination-user";
  assert.equal(codeOf(unknown), "AccountNotFound");
  assert.equal(codeOf(wrongOwner), "AccountNotFound");
  assert.equal(wrongOwner.message, unknown.message);
  assert.equal(wrongOwner.status, unknown.status);
  await assert.rejects(issue(f, op, current + 1), hasCode("OperationConflict"));
  assert.equal((await families(f)).length, 0);
  // A configured host that no longer matches the saved placement is refused.
  f.config.pds[0].url = "https://elsewhere.example.test";
  await assert.rejects(issue(f, op, current), hasCode("OperationConflict"));
  f.config.pds[0].url = "https://destination.example.test";
  assert.equal((await families(f)).length, 0);
  await issue(f, op, current);
  await assert.rejects(issue(f, op), hasCode("OperationConflict"));
  assert.equal((await families(f)).length, 1);
});

test("ordinary login, access and refresh never accept a pending arrival credential", async (t) => {
  const { f, op } = await bound(t);
  const session = await issue(f, op);
  await assert.rejects(
    f.legacy.verifyAccess(session.accessJwt),
    hasCode("AccountUnavailable"),
  );
  await assert.rejects(
    f.legacy.refreshSession(session.refreshJwt),
    hasCode("AccountUnavailable"),
  );
  await assert.rejects(
    f.legacy.createAccountSession(f.did),
    hasCode("AccountUnavailable"),
  );
  // A real main password must still not open a pending account.
  await f.db.set("legacy:passwords", f.did, {
    hash: await hashPassword("correct-horse-battery"),
    revision: "r1",
    updatedAt: new Date(),
  });
  await assert.rejects(
    f.legacy.createSession({
      identifier: f.did,
      password: "correct-horse-battery",
    }),
    hasCode("AccountUnavailable"),
  );
  await assert.rejects(
    f.legacy.createSession({ identifier: f.did, password: "wrong-password!!" }),
    hasCode("AuthenticationRequired"),
  );
  // The ordinary refusals did not consume or revoke the tracked family.
  assert.equal((await families(f))[0].revoked_at, null);
  const refreshed = await f.composed.refreshArrivalSession(session.refreshJwt);
  assert.ok(refreshed.accessJwt);
});

test("refresh rotates, replay revokes the family and non-refresh tokens are rejected", async (t) => {
  const { f, op } = await bound(t);
  const first = await issue(f, op);
  await assert.rejects(
    f.composed.refreshArrivalSession(first.accessJwt),
    hasCode("InvalidToken"),
  );
  const second = await f.composed.refreshArrivalSession(first.refreshJwt);
  assert.notEqual(second.refreshJwt, first.refreshJwt);
  assert.equal(decodeJwt(second.accessJwt).sid, decodeJwt(first.accessJwt).sid);
  assert.equal(second.status, "deactivated");
  await assert.rejects(
    f.composed.refreshArrivalSession(first.refreshJwt),
    hasCode("ExpiredToken"),
  );
  // Replay revoked the whole family, including the rotated credential.
  await assert.rejects(
    f.composed.refreshArrivalSession(second.refreshJwt),
    hasCode("ExpiredToken"),
  );
  assert.ok(JSON.parse((await sessions(f))[0].value).revokedAt);
});

test("a refresh credential for an untracked family is not an arrival credential", async (t) => {
  const { f, op } = await bound(t);
  await issue(f, op);
  const forged = await sign(
    f,
    {
      payload: { scope: "com.atproto.refresh", sid: "s".repeat(43) },
      sub: f.did,
      aud: f.config.serviceDid,
    },
    "refresh+jwt",
  );
  await assert.rejects(
    f.composed.refreshArrivalSession(forged),
    hasCode("InvalidToken"),
  );
});

test("concurrent refreshes of one credential succeed at most once", async (t) => {
  const { f, op } = await bound(t);
  const session = await issue(f, op);
  const results = await Promise.allSettled([
    f.composed.refreshArrivalSession(session.refreshJwt),
    f.composed.refreshArrivalSession(session.refreshJwt),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failure = results.find((r) => r.status === "rejected");
  assert.equal(codeOf(failure.reason), "ExpiredToken");
});

test("concurrent refresh and recovery leave exactly one usable family", async (t) => {
  const { f, op } = await bound(t);
  const session = await issue(f, op);
  const expected = await version(f, op);
  const [refreshed, recovered] = await Promise.allSettled([
    f.composed.refreshArrivalSession(session.refreshJwt),
    recover(f, op, expected),
  ]);
  assert.equal(recovered.status, "fulfilled");
  if (refreshed.status === "fulfilled")
    await assert.rejects(
      f.composed.refreshArrivalSession(refreshed.value.refreshJwt),
      hasCode("ExpiredToken"),
    );
  else assert.equal(codeOf(refreshed.reason), "ExpiredToken");
  assert.equal(
    (await families(f)).filter((r) => r.revoked_at === null).length,
    1,
  );
  const usable = await f.composed.refreshArrivalSession(
    recovered.value.refreshJwt,
  );
  assert.ok(usable.accessJwt);
});

test("recovery replaces every prior refresh family in the same commit (M3) without remote effects", async (t) => {
  const { f, op } = await bound(t);
  const first = await issue(f, op);
  const effects = remoteEffects(f);
  // The source key/JWT is irrelevant after cutover, and the arrival code has expired.
  await query(
    f.db,
    "UPDATE arrival_code SET issued_at = 1, expires_at = 2",
    [],
    "run",
  );
  const second = await recover(f, op);
  assert.deepEqual(remoteEffects(f), effects);
  await assert.rejects(
    f.composed.refreshArrivalSession(first.refreshJwt),
    hasCode("ExpiredToken"),
  );
  await assert.rejects(
    f.composed.authorizeArrivalAccess(first.accessJwt),
    hasCode("ExpiredToken"),
  );
  const rows = await families(f);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.filter((r) => r.revoked_at === null).map((r) => r.family_id),
    [decodeJwt(second.accessJwt).sid],
  );
  // The legacy family itself is revoked, not only the arrival metadata, so it
  // cannot be refreshed through ordinary routes after completion either.
  const legacyRows = (await sessions(f)).map((row) => JSON.parse(row.value));
  assert.deepEqual(
    legacyRows.filter((row) => row.revokedAt).map((row) => row.id),
    [decodeJwt(first.accessJwt).sid],
  );
  assert.equal(
    legacyRows.find((row) => row.revokedAt).revocationReason,
    "arrival-recovered",
  );
  // A lost response is recovered again: still one active replacement family.
  const third = await recover(f, op);
  await assert.rejects(
    f.composed.refreshArrivalSession(second.refreshJwt),
    hasCode("ExpiredToken"),
  );
  assert.equal(
    (await families(f)).filter((r) => r.revoked_at === null).length,
    1,
  );
  assert.ok(
    (await f.composed.refreshArrivalSession(third.refreshJwt)).accessJwt,
  );
  assert.deepEqual(remoteEffects(f), effects);
});

test("recovery needs the saved user, fresh proof and exact version; wrong owner equals unknown", async (t) => {
  const { f, op } = await bound(t);
  await issue(f, op);
  const current = await version(f, op);
  await assert.rejects(
    recover(f, op, current, "stale-otp"),
    hasCode("ArrivalProofRequired"),
  );
  await assert.rejects(
    recover(f, op, current - 1),
    hasCode("OperationConflict"),
  );
  await assert.rejects(
    f.composed.recoverArrivalSession(f.request, "fresh-otp", {
      operationId: op,
      expectedVersion: "1",
    }),
    hasCode("InvalidRequest"),
  );
  const unknown = await recover(f, "no-such-operation", 1).catch((e) => e);
  f.principal.userId = "someone-else";
  const wrongOwner = await recover(f, op, current).catch((e) => e);
  f.principal.userId = "destination-user";
  assert.equal(codeOf(unknown), "AccountNotFound");
  assert.equal(codeOf(wrongOwner), "AccountNotFound");
  assert.equal(wrongOwner.message, unknown.message);
  assert.equal((await families(f)).length, 1);
  assert.equal((await families(f))[0].revoked_at, null);
});

test("a failed association leaves no usable or untracked family and revokes nothing", async (t) => {
  const { f, op } = await bound(t);
  await failureTrigger(
    f.db,
    "reject_family",
    "arrival_families",
    "family rollback",
  );
  const before = await version(f, op);
  await assert.rejects(issue(f, op), hasFailure("family rollback"));
  assert.equal((await sessions(f)).length, 0);
  assert.equal((await refreshRows(f)).length, 0);
  assert.equal(await version(f, op), before);
  await removeFailureTrigger(f.db, "reject_family", "arrival_families");
  const session = await issue(f, op);
  await failureTrigger(
    f.db,
    "reject_family",
    "arrival_families",
    "family rollback",
  );
  await assert.rejects(recover(f, op), hasFailure("family rollback"));
  // The previous family survives untouched and the failed replacement left no rows.
  assert.equal((await sessions(f)).length, 1);
  assert.equal(
    (await families(f)).filter((r) => r.revoked_at === null).length,
    1,
  );
  await removeFailureTrigger(f.db, "reject_family", "arrival_families");
  assert.ok(
    (await f.composed.refreshArrivalSession(session.refreshJwt)).accessJwt,
  );
});

test("refresh and access credentials expire", async (t) => {
  const { f, op } = await bound(t);
  const session = await issue(f, op);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(6 * 60 * 1000);
  await assert.rejects(
    f.composed.authorizeArrivalAccess(session.accessJwt),
    hasCode("ExpiredToken"),
  );
  t.mock.timers.tick(91 * 24 * 60 * 60 * 1000);
  await assert.rejects(
    f.composed.refreshArrivalSession(session.refreshJwt),
    hasCode("ExpiredToken"),
  );
});

test("access authorization requires exact subject, audience, type, scope and a tracked family", async (t) => {
  const { f, op } = await bound(t);
  const session = await issue(f, op);
  const sid = decodeJwt(session.accessJwt).sid;
  const good = {
    payload: { scope: "com.atproto.access", sid },
    sub: f.did,
    aud: pdsDid,
  };
  const authorized = await f.composed.authorizeArrivalAccess(session.accessJwt);
  assert.equal(authorized.did, f.did);
  assert.equal(authorized.operationId, op);
  assert.equal(authorized.userId, "destination-user");
  for (const [name, claims, typ, code] of [
    [
      "wrong subject",
      { ...good, sub: "did:plc:" + "b".repeat(24) },
      "at+jwt",
      "InvalidToken",
    ],
    [
      "wrong audience",
      { ...good, aud: "did:web:other.example.test" },
      "at+jwt",
      "InvalidToken",
    ],
    [
      "app-password scope",
      { ...good, payload: { scope: "com.atproto.appPass", sid } },
      "at+jwt",
      "InvalidToken",
    ],
    ["refresh type", good, "refresh+jwt", "InvalidToken"],
    [
      "untracked family",
      {
        ...good,
        payload: { scope: "com.atproto.access", sid: "u".repeat(43) },
      },
      "at+jwt",
      "ExpiredToken",
    ],
  ])
    await assert.rejects(
      f.composed.authorizeArrivalAccess(await sign(f, claims, typ)),
      hasCode(code),
      name,
    );
  await assert.rejects(
    f.composed.authorizeArrivalAccess(session.refreshJwt),
    hasCode("InvalidToken"),
  );
});

const tamper = {
  "saved binding": [
    "AccountMismatch",
    async (f) => {
      await verifiedUser(f.db, "other-user", "other@example.test");
      await query(
        f.db,
        "UPDATE account_bindings SET user_id = 'other-user'",
        [],
        "run",
      );
    },
  ],
  "account status": [
    "OperationConflict",
    async (f) => {
      await query(
        f.db,
        "UPDATE accounts SET status = 'deactivated', data = replace(data, '\"provisioning\"', '\"deactivated\"')",
        [],
        "run",
      );
    },
  ],
  "unresolved attempt": [
    "OperationRecoveryRequired",
    async (f) => {
      await query(
        f.db,
        "INSERT INTO arrival_attempts (attempt_binding, ownership_operation_id, attempt_id, operation_id, reason, recorded_at, fence) SELECT 'b', operation_id, 'a', operation_id, 'external:incoming-pause', 1, 1 FROM arrivals",
        [],
        "run",
      );
    },
  ],
};
for (const [name, [code, mutate]] of Object.entries(tamper))
  for (const action of ["issue", "recover"])
    test(`${action} refuses a changed ${name} and mints nothing`, async (t) => {
      const { f, op } = await bound(t);
      if (action === "recover") await issue(f, op);
      const rows = (await families(f)).length;
      await mutate(f);
      await assert.rejects(
        action === "issue" ? issue(f, op) : recover(f, op),
        hasCode(code),
      );
      assert.equal((await families(f)).length, rows);
      assert.equal((await sessions(f)).length, rows);
    });

test("refresh is refused when the saved account facts changed, and never refreshes then", async (t) => {
  const { f, op } = await bound(t);
  const session = await issue(f, op);
  await tamper["account status"][1](f);
  await assert.rejects(
    f.composed.refreshArrivalSession(session.refreshJwt),
    hasCode("OperationConflict"),
  );
});

test("an unresolved attempt alone does not stop a refresh", async (t) => {
  const { f, op } = await bound(t);
  const session = await issue(f, op);
  await tamper["unresolved attempt"][1](f);
  assert.ok(
    (await f.composed.refreshArrivalSession(session.refreshJwt)).accessJwt,
  );
});

for (const [name, mutate, code] of [
  [
    "cancelled arrival",
    (f) =>
      query(
        f.db,
        "UPDATE arrivals SET cancelled_at = 1, did_root = NULL, active = 0",
        [],
        "run",
      ),
    "ArrivalExpired",
  ],
  [
    "changed account",
    (f) => tamper["account status"][1](f),
    "OperationConflict",
  ],
])
  test(`refresh rechecks pending state and saved facts under the fence: ${name}`, async (t) => {
    const { f, op } = await bound(t);
    const session = await issue(f, op);
    const resume = f.ownership.resumePending.bind(f.ownership);
    f.ownership.resumePending = async (...args) => {
      f.ownership.resumePending = resume;
      await mutate(f);
      return resume(...args);
    };
    await assert.rejects(
      f.composed.refreshArrivalSession(session.refreshJwt),
      hasCode(code),
    );
    assert.ok(op);
  });

test("concurrent recoveries leave exactly one replacement family", async (t) => {
  const { f, op } = await bound(t);
  await issue(f, op);
  const expected = await version(f, op);
  const results = await Promise.allSettled([
    recover(f, op, expected),
    recover(f, op, expected),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    codeOf(results.find((r) => r.status === "rejected").reason),
    "OperationConflict",
  );
  assert.equal(
    (await families(f)).filter((r) => r.revoked_at === null).length,
    1,
  );
  assert.equal((await families(f)).length, 2);
});

test("recovery needs no source credential and the source key is no longer current", async (t) => {
  const { f, op } = await bound(t);
  await issue(f, op);
  const issued = f.credentialsIssued();
  const head = f.audit.at(-1).operation;
  assert.notEqual(head.verificationMethods.atproto, f.source.did());
  assert.ok((await recover(f, op)).accessJwt);
  assert.equal(f.credentialsIssued(), issued);
});

test("ordinary account changes remain refused for a pending arrival", async (t) => {
  const { f, op } = await bound(t);
  const primitives = createAccountPrimitives({
    db: f.db,
    config: f.config,
    storage: f.storage,
    ownership: f.ownership,
  });
  await assert.rejects(
    primitives.assertNoMigration(f.did),
    hasCode("MigrationPending"),
  );
  const row = await f.storage.getByDid(f.did);
  await assert.rejects(
    f.storage.saveAccount({ ...row, status: "active" }),
    hasCode("IdentityConflict"),
  );
  assert.ok(op);
});

const retrack = async (f, sid, patch) => {
  const row = await f.db.get("legacy:sessions", sid);
  await f.db.set("legacy:sessions", sid, { ...row, ...patch });
};
test("access authorization pins scope, audience and host independently of the token", async (t) => {
  const { f, op } = await bound(t);
  const session = await issue(f, op);
  const sid = decodeJwt(session.accessJwt).sid;
  const other = "did:web:other.example.test";
  const claims = (aud, scope) => ({
    payload: { scope, sid },
    sub: f.did,
    aud,
  });
  // Family stored on another host: the token matches it, the arrival's placement does not.
  await retrack(f, sid, { pdsDid: other });
  await assert.rejects(
    f.composed.authorizeArrivalAccess(
      await sign(f, claims(other, "com.atproto.access")),
    ),
    hasCode("InvalidToken"),
  );
  await retrack(f, sid, { pdsDid: pdsDid });
  // A token for another configured PDS cannot use this family.
  await assert.rejects(
    f.composed.authorizeArrivalAccess(
      await sign(f, claims(other, "com.atproto.access")),
    ),
    hasCode("InvalidToken"),
  );
  // An app-password family is never an arrival credential, even if its token matches.
  await retrack(f, sid, { scope: "com.atproto.appPass" });
  await assert.rejects(
    f.composed.authorizeArrivalAccess(
      await sign(f, claims(pdsDid, "com.atproto.appPass")),
    ),
    hasCode("InvalidToken"),
  );
  await retrack(f, sid, { scope: "com.atproto.access", appPasswordId: "x" });
  await assert.rejects(
    f.composed.authorizeArrivalAccess(
      await sign(f, claims(pdsDid, "com.atproto.access")),
    ),
    hasCode("InvalidToken"),
  );
  await retrack(f, sid, { appPasswordId: undefined });
  assert.ok((await f.composed.authorizeArrivalAccess(session.accessJwt)).did);
  // Tracking metadata for another host is refused as well.
  await query(f.db, "UPDATE arrival_families SET pds_id = 'pds2'", [], "run");
  await assert.rejects(
    f.composed.authorizeArrivalAccess(session.accessJwt),
    hasCode("InvalidToken"),
  );
});

test("cookie-less creation issuance is the continuation of an accepted, bound creation", async (t) => {
  const f = await fixture(t);
  const prepared = await admitProvisioning(f);
  const op = prepared.operationId;
  const input = {
    did: f.did,
    operationId: op,
    arrivalCode: prepared.arrivalCode,
  };
  // Not bound yet.
  await assert.rejects(
    f.composed.issueCreationSession(input),
    hasCode("OperationConflict"),
  );
  await f.composed.continueCreation(f.request, op);
  // No browser request is involved; the code and operation select the saved user.
  for (const bad of [
    { ...input, arrivalCode: "wrong-code" },
    { ...input, did: "did:plc:" + "b".repeat(24) },
    { ...input, operationId: "other-operation" },
  ])
    await assert.rejects(
      f.composed.issueCreationSession(bad),
      hasCode("ArrivalExpired"),
    );
  assert.equal((await families(f)).length, 0);
  const session = await f.composed.issueCreationSession(input);
  assert.equal(decodeJwt(session.accessJwt).sub, f.did);
  assert.equal((await families(f)).length, 1);
  await assert.rejects(
    f.composed.issueCreationSession(input),
    hasCode("OperationConflict"),
  );
  assert.equal((await families(f)).length, 1);
});

test("creation issuance needs an accepted creation admission for the saved user", async (t) => {
  const { f, op } = await bound(t);
  await query(
    f.db,
    "DELETE FROM arrival_replay WHERE method = 'com.atproto.server.createAccount'",
    [],
    "run",
  );
  await assert.rejects(
    f.composed.issueCreationSession({
      did: f.did,
      operationId: op,
      arrivalCode: f.arrivalCode,
    }),
    hasCode("AccountMismatch"),
  );
  assert.equal((await families(f)).length, 0);
});

test("creation issuance rolls back completely on a failed association", async (t) => {
  const { f, op } = await bound(t);
  await failureTrigger(
    f.db,
    "reject_family",
    "arrival_families",
    "family rollback",
  );
  await assert.rejects(
    f.composed.issueCreationSession({
      did: f.did,
      operationId: op,
      arrivalCode: f.arrivalCode,
    }),
    hasFailure("family rollback"),
  );
  assert.equal((await sessions(f)).length, 0);
  assert.equal((await families(f)).length, 0);
});

for (const [name, statement] of [
  [
    "another user",
    "UPDATE arrival_replay SET user_id = 'other-user' WHERE method = 'com.atproto.server.createAccount'",
  ],
  [
    "another DID",
    "UPDATE arrival_replay SET did = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' WHERE method = 'com.atproto.server.createAccount'",
  ],
  [
    "an unrecorded code generation",
    "UPDATE arrival_replay SET generation = 99 WHERE method = 'com.atproto.server.createAccount'",
  ],
])
  test(`creation issuance refuses an admission recorded for ${name}`, async (t) => {
    const { f, op } = await bound(t);
    await verifiedUser(f.db, "other-user", "other@example.test");
    await query(f.db, statement, [], "run");
    await assert.rejects(
      f.composed.issueCreationSession({
        did: f.did,
        operationId: op,
        arrivalCode: f.arrivalCode,
      }),
      hasCode("AccountMismatch"),
    );
    assert.equal((await families(f)).length, 0);
  });
