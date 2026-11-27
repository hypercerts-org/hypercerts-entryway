import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { eq } from "drizzle-orm";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createControllerChallenges } from "../../dist/src/database/drizzle/controller-challenges.js";
import {
  ControllerBindingVerifier,
  controllerBindingBytes,
} from "../../dist/src/pds/deployment-controller-contract.js";
import { testDatabaseConfiguration } from "../support/database-fixture.mjs";

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "controller-challenge-"));
  const configuration = await testDatabaseConfiguration(
    join(directory, "authority.sqlite"),
  );
  const first = await openDatabase(configuration);
  const second = await openDatabase(configuration);
  t.after(async () => {
    await second.close();
    await first.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { first, second, configuration };
}
const context = {
  issuer: "controller",
  audience: "fleet",
  controllerEpoch: "epoch",
  deploymentId: "deployment",
  hostId: "host",
  revision: 1,
  serviceDid: "did:web:host.example",
  publicEndpoint: "https://host.example/",
};
const digest = `sha256:${"a".repeat(64)}`;
const keys = generateKeyPairSync("ed25519");
function statement(expected, observedAt, expiresAt) {
  const unsigned = {
    version: 1,
    ...expected,
    keyId: "key",
    purpose: "describe-binding",
    routeId: "route",
    generation: 1,
    imageDigest: digest,
    configDigest: digest,
    launcherDigest: digest,
    incarnation: "instance",
    observedAt,
    expiresAt,
  };
  return JSON.stringify({
    ...unsigned,
    signature: sign(
      null,
      controllerBindingBytes(unsigned),
      keys.privateKey,
    ).toString("base64url"),
  });
}
function verifier(store) {
  return new ControllerBindingVerifier(
    new Map([["controller", new Map([["key", keys.publicKey]])]]),
    store.consume,
  );
}

test("one issued challenge is consumed once across connections and restart", async (t) => {
  const { first, second, configuration } = await fixture(t);
  const left = createControllerChallenges(first),
    right = createControllerChallenges(second);
  const issued = await left.issue(context, 30000);
  const now = await first.databaseTime();
  const raw = statement(issued.expected, now, issued.expiresAt);
  const outcomes = await Promise.allSettled([
    verifier(left).verify(raw, issued.expected, () => now),
    verifier(right).verify(raw, issued.expected, () => now),
  ]);
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.filter(
      (result) =>
        result.status === "rejected" &&
        ["ControllerChallengeReplayed", "ControllerUnavailable"].includes(
          result.reason.code,
        ),
    ).length,
    1,
  );
  await assert.rejects(
    verifier(right).verify(raw, issued.expected, () => now),
    { code: "ControllerChallengeReplayed" },
  );
  const reopened = await openDatabase(configuration);
  try {
    await assert.rejects(
      verifier(createControllerChallenges(reopened)).verify(
        raw,
        issued.expected,
        () => now,
      ),
      { code: "ControllerChallengeReplayed" },
    );
  } finally {
    await reopened.close();
  }
});

test("challenge is bound to exact context and database expiry", async (t) => {
  const { first } = await fixture(t);
  const store = createControllerChallenges(first);
  const issued = await store.issue(context, 20000);
  const now = await first.databaseTime();
  const changed = { ...issued.expected, hostId: "other" };
  await assert.rejects(
    verifier(store).verify(
      statement(changed, now, issued.expiresAt),
      changed,
      () => now,
    ),
    { code: "ControllerChallengeReplayed" },
  );
  await assert.rejects(
    verifier(store).verify(
      statement(issued.expected, now, issued.expiresAt + 1),
      issued.expected,
      () => now,
    ),
    { code: "ControllerChallengeReplayed" },
  );
  assert.equal(
    (
      await verifier(store).verify(
        statement(issued.expected, now, issued.expiresAt),
        issued.expected,
        () => now,
      )
    ).hostId,
    "host",
  );
  const lagged = await store.issue(context, 30000);
  const databaseNow = await first.databaseTime();
  const oldStatement = statement(
    lagged.expected,
    databaseNow - 2000,
    databaseNow - 1000,
  );
  await assert.rejects(
    verifier(store).verify(
      oldStatement,
      lagged.expected,
      () => databaseNow - 1500,
    ),
    { code: "ControllerChallengeReplayed" },
  );
  assert.equal(
    (
      await verifier(store).verify(
        statement(lagged.expected, databaseNow, lagged.expiresAt),
        lagged.expected,
        () => databaseNow,
      )
    ).hostId,
    "host",
  );
  const expired = await store.issue(context, 30000);
  const then = await first.databaseTime();
  await first.update(
    "controller_challenges",
    { expires_at: then },
    eq(first.tables.controller_challenges.nonce, expired.expected.nonce),
  );
  await assert.rejects(
    verifier(store).verify(
      statement(expired.expected, then, expired.expiresAt),
      expired.expected,
      () => then,
    ),
    { code: "ControllerChallengeReplayed" },
  );
  await assert.rejects(store.issue(context, 30001), {
    code: "ControllerInvalidResponse",
  });
});
