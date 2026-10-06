import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { openTestDatabase } from "../../../tests/support/database-fixture.mjs";
import {
  createOperationOwnership,
  noExternalResult,
} from "../../../dist/src/accounts/operation-ownership.js";
import { createOperationOwnershipStore } from "../../../dist/src/database/drizzle/operation-ownership.js";
import { mountOperationRecoveryRoutes } from "../../../dist/src/features/account-settings/operation-recovery-routes.js";
import { createSignupForm } from "../../../dist/src/features/account-registration/page.mjs";

test("operator recovery requires Entryway authorization and exact nonreplayable attempt while preserving saved signup context", async (t) => {
  const db = await openTestDatabase();
  t.after(() => db.close());
  const ownership = createOperationOwnership({
    store: createOperationOwnershipStore(db),
    heartbeatMs: 0,
  });
  const resource = "email:owner@example.test";
  await assert.rejects(
    ownership.run(
      resource,
      { kind: "create", request: { handle: "saved.example.test" } },
      () =>
        ownership.dispatch(
          {
            step: "create",
            target: "https://pds.example.test",
            method: "com.atproto.server.createAccount",
            intent: { did: "did:plc:saved" },
          },
          {
            ...noExternalResult,
            send: async () => {
              throw Error("controlled transport failure");
            },
            observe: async () => ({ state: "diverged" }),
          },
        ),
    ),
    /controlled transport failure/,
  );
  const app = express();
  app.use(express.json());
  mountOperationRecoveryRoutes({
    app,
    config: { adminPassword: "entryway-recovery-test" },
    ownership,
  });
  app.use((error, _req, res, _next) =>
    res.status(error.status ?? 500).json({ error: error.code ?? error.error }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (path, body, password = "entryway-recovery-test") =>
    fetch(origin + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`,
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await call("/_operations/status", { resource }, "pds-admin")).status,
    401,
  );
  const status = await (await call("/_operations/status", { resource })).json();
  assert.equal(status.status, "recovery-required");
  assert.equal(Object.hasOwn(status.attempt, "result"), false);
  assert.equal(Object.hasOwn(status.attempt, "intentDigest"), false);
  assert.equal((await call("/_operations/recovery", {})).status, 400);
  const { operationId, externalAttemptId, executionAttemptId, target } =
    status.attempt;
  const acknowledgement = {
    operationId,
    externalAttemptId,
    executionAttemptId,
    target,
    action: "observe",
    dispatcherIsolationReference: "fixture:dispatcher-completed",
    upstreamDrainReference: "fixture:transport-completed",
  };
  assert.equal(
    (
      await call("/_operations/recovery", {
        ...acknowledgement,
        target: "https://other.example.test",
      })
    ).status,
    409,
  );
  const account = {
    did: "did:plc:saved",
    status: "provisioning",
    handle: "saved.example.test",
    pdsId: "pds1",
  };
  const form = createSignupForm({
    db,
    accounts: { ownership, get: async () => account },
    config: {
      pds: [{ id: "pds1", url: target }],
      handleDomains: [".example.test"],
    },
    fields: () => "",
  });
  const before = await form({ authEmail: "owner@example.test" }, {});
  assert.match(before, /Waiting for operator recovery/);
  assert.match(before, /saved\.example\.test/);
  assert.match(before, /retrying alone cannot resolve/i);
  assert.equal(before.includes(externalAttemptId), false);
  const response = await call("/_operations/recovery", acknowledgement);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pending, true);
  assert.equal(
    (await call("/_operations/recovery", acknowledgement)).status,
    409,
  );
  assert.equal(
    (await ownership.pendingExternal(resource)).state,
    "recovery-approved",
  );
  const after = await form({ authEmail: "owner@example.test" }, {});
  assert.match(after, /Retry account setup/);
  assert.match(after, /saved\.example\.test/);
  assert.doesNotMatch(after, /Waiting for operator recovery/);
  const authorized = await (
    await call("/_operations/status", { resource })
  ).json();
  assert.equal(authorized.authorization.action, "observe");
  assert.equal(authorized.authorization.version, 1);
  assert.deepEqual(Object.keys(authorized.authorization).sort(), [
    "action",
    "id",
    "version",
  ]);
  const upgrade = {
    ...acknowledgement,
    action: "retry-if-safe",
    previousAuthorization: {
      id: authorized.authorization.id,
      version: authorized.authorization.version,
    },
  };
  assert.equal(
    (await call("/_operations/recovery", upgrade, "pds-admin")).status,
    401,
  );
  assert.equal(
    (
      await call("/_operations/recovery", {
        ...upgrade,
        previousAuthorization: { id: "stale", version: 1 },
      })
    ).status,
    409,
  );
  for (const previousAuthorization of [
    null,
    [],
    { id: upgrade.previousAuthorization.id, version: "1" },
    { ...upgrade.previousAuthorization, force: true },
  ])
    assert.equal(
      (
        await call("/_operations/recovery", {
          ...upgrade,
          previousAuthorization,
        })
      ).status,
      400,
    );
  assert.equal((await call("/_operations/recovery", upgrade)).status, 200);
  assert.equal((await call("/_operations/recovery", upgrade)).status, 409);
  const upgraded = await (
    await call("/_operations/status", { resource })
  ).json();
  assert.equal(upgraded.authorization.action, "retry-if-safe");
  assert.equal(upgraded.authorization.version, 2);
  assert.notEqual(upgraded.authorization.id, authorized.authorization.id);
  assert.equal(Object.hasOwn(upgraded, "recoveryHistory"), false);
  const history = (await ownership.pendingExternal(resource)).recoveryHistory;
  assert.equal(history.length, 2);
  assert.equal(history[0].id, authorized.authorization.id);
});
