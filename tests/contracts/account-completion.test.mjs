import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, alice } from "../support/account-fixture.mjs";
import { createOperationOwnership } from "../../dist/src/accounts/operation-ownership.js";
import { createOperationOwnershipStore } from "../../dist/src/database/drizzle/operation-ownership.js";

for (const kind of ["create", "status", "handle", "delete"])
  test(`reopen reconciles acknowledged ${kind} after local completion without replaying its external effect`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "completed-account-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let interrupt = false;
    const f = await fixture(t, undefined, {
      path: join(directory, "authority.sqlite"),
      ownershipFactory: (db) => {
        const store = createOperationOwnershipStore(db);
        return createOperationOwnership({
          store: {
            ...store,
            async checkpoint(claim, input) {
              if (
                interrupt &&
                claim.kind === kind &&
                input.phase === "complete"
              ) {
                interrupt = false;
                throw Error("Interrupted after local completion");
              }
              return store.checkpoint(claim, input);
            },
          },
        });
      },
    });
    let account;
    if (kind !== "create") account = await f.accounts.create(alice);
    if (kind === "delete") {
      await f.db.set("test:deletion-cleanup", account.did, true);
      f.accounts.setDeletionFinalizer((did) =>
        f.db.delete("test:deletion-cleanup", did),
      );
    }
    interrupt = true;
    const renamed = "completed.entryway.atmosbox.test";
    await assert.rejects(
      kind === "create"
        ? f.accounts.create(alice)
        : kind === "status"
          ? f.accounts.setStatus(account.did, "deactivated")
          : kind === "handle"
            ? f.accounts.updateHandle(account.did, renamed)
            : f.accounts.deleteAccount(account.did),
      /Interrupted after local completion/,
    );
    account = await f.accounts.get(alice.email);
    assert.equal(
      (await f.db.get("operations", `${kind}:${account.did}`)).phase,
      "complete",
    );
    assert.equal(await f.accounts.ownership.pendingExternal(account.did), null);
    const intent = {
      kind,
      request:
        kind === "create"
          ? { ...alice, recoveryKey: null }
          : kind === "status"
            ? { status: "deactivated", deleteAfter: null }
            : kind === "handle"
              ? { handle: renamed }
              : {},
    };
    const nominated = await f.accounts.ownership.acknowledgedPendingId(
      account.did,
      intent,
    );
    assert.ok(nominated);
    await assert.rejects(
      f.accounts.ownership.accountStep(
        account.did,
        { kind: "conflicting-local", request: {} },
        async () => {},
      ),
      { code: "OperationPending" },
    );
    const writes = f.calls.filter((call) => call.body !== undefined).length;
    await f.reopen();
    const recovered = await f.accounts.reconcile();
    assert.ok(
      recovered.some(
        (row) =>
          row.id === `${kind}:${account.did}` && row.status === "complete",
      ),
    );
    assert.equal(
      f.calls.filter((call) => call.body !== undefined).length,
      writes,
    );
    assert.equal(
      await f.accounts.ownership.acknowledgedPendingId(account.did, intent),
      null,
    );
    await assert.rejects(
      f.accounts.ownership.resumeAcknowledged(
        account.did,
        nominated,
        intent,
        async () => {
          throw Error("Stale nomination ran");
        },
      ),
      { code: "OperationNoLongerPending" },
    );
    if (kind === "handle") {
      assert.equal((await f.accounts.get(account.did)).handle, renamed);
      assert.equal(await f.accounts.storage.getHandleClaim(alice.handle), null);
      assert.equal(
        await f.accounts.storage.getHandleClaim(renamed),
        account.did,
      );
    }
    if (kind === "delete")
      assert.equal(await f.db.get("test:deletion-cleanup", account.did), null);
    await f.accounts.ownership.accountStep(
      account.did,
      { kind: "conflicting-local", request: {} },
      () => f.db.set("test:completion", account.did, true),
    );
    assert.equal(await f.db.get("test:completion", account.did), true);
  });

test("deletion cleanup failure rolls back local completion and retries the acknowledged delete without another PDS write", async (t) => {
  const f = await fixture(t);
  const account = await f.accounts.create(alice);
  await f.db.set("test:deletion-cleanup", account.did, true);
  f.accounts.setDeletionFinalizer(async (did) => {
    await f.db.delete("test:deletion-cleanup", did);
    throw Error("Cleanup persistence failure");
  });
  await assert.rejects(
    f.accounts.deleteAccount(account.did),
    /Cleanup persistence failure/,
  );
  assert.equal((await f.accounts.get(account.did)).status, "active");
  assert.equal(
    (await f.db.get("operations", `delete:${account.did}`)).phase,
    "pds-pending",
  );
  assert.equal(await f.db.get("test:deletion-cleanup", account.did), true);
  f.accounts.setDeletionFinalizer((did) =>
    f.db.delete("test:deletion-cleanup", did),
  );
  assert.equal((await f.accounts.reconcile())[0].status, "complete");
  assert.equal((await f.accounts.get(account.did)).status, "deleted");
  assert.equal(await f.db.get("test:deletion-cleanup", account.did), null);
  assert.equal(
    f.calls.filter((call) => call.method === "com.atproto.admin.deleteAccount")
      .length,
    1,
  );
});

test("acknowledged pre-DID key allocation retains saved signup context and reconciles without reallocating", async (t) => {
  const { Secp256k1Keypair } = await import("@atproto/crypto");
  const { createSignupForm } =
    await import("../../dist/src/features/account-registration/page.mjs");
  const directory = mkdtempSync(join(tmpdir(), "pre-did-completion-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let interrupt = true;
  const f = await fixture(t, undefined, {
    path: join(directory, "authority.sqlite"),
    ownershipFactory: (db) => {
      const store = createOperationOwnershipStore(db);
      return createOperationOwnership({
        store: {
          ...store,
          async acknowledgeExternal(claim, attempt, result) {
            await store.acknowledgeExternal(claim, attempt, result);
            if (interrupt && attempt.step === "reserve-signing-key") {
              interrupt = false;
              throw Error("Interrupted after key acknowledgement");
            }
          },
        },
      });
    },
  });
  const original = {
    ...alice,
    recoveryKey: (await Secp256k1Keypair.create()).did(),
  };
  await assert.rejects(
    f.accounts.create(original),
    /Interrupted after key acknowledgement/,
  );
  assert.equal(await f.accounts.get(alice.email), null);
  assert.equal(
    await f.accounts.ownership.pendingExternal(`email:${alice.email}`),
    null,
  );
  await f.reopen();
  assert.deepEqual(await f.accounts.pendingRegistration(alice.email), original);
  const html = await createSignupForm({
    db: f.db,
    accounts: f.accounts,
    config: {
      pds: [{ id: "pds1", url: "https://pds1.entryway.atmosbox.test" }],
      handleDomains: [".entryway.atmosbox.test"],
    },
    fields: () => "",
  })({ authEmail: alice.email }, {});
  assert.ok(html.includes(`value="${alice.handle}" readonly`));
  assert.ok(html.includes("Retry account setup"));
  assert.ok(html.includes('value="pds1" selected'));
  await assert.rejects(
    f.accounts.create({
      ...original,
      recoveryKey: (await Secp256k1Keypair.create()).did(),
    }),
    { code: "OperationPending" },
  );
  assert.equal((await f.accounts.reconcile())[0].status, "complete");
  const completed = await f.accounts.get(alice.email);
  assert.equal(completed.recoveryKey, original.recoveryKey);
  assert.equal(completed.handle, alice.handle);
  assert.equal(completed.pdsId, alice.pdsId);
  assert.equal(
    f.calls.filter(
      (call) => call.method === "com.atproto.server.reserveSigningKey",
    ).length,
    1,
  );
  assert.equal(await f.accounts.pendingRegistration(alice.email), null);
});

for (const boundary of ["pre-did", "locally-complete"])
  test(
    `a queued matching public create cannot deadlock ${boundary} registration reconciliation`,
    { timeout: 15000 },
    async (t) => {
      let interrupt = true;
      let holdContinuation = false;
      const admitted = Promise.withResolvers();
      const release = Promise.withResolvers();
      const f = await fixture(t, undefined, {
        ownershipFactory: (db) => {
          const store = createOperationOwnershipStore(db);
          return createOperationOwnership({
            store: {
              ...store,
              async acquire(input) {
                const claim = await store.acquire(input);
                if (holdContinuation && input.continuation) {
                  holdContinuation = false;
                  admitted.resolve();
                  await release.promise;
                }
                return claim;
              },
              async acknowledgeExternal(claim, attempt, result) {
                await store.acknowledgeExternal(claim, attempt, result);
                if (
                  interrupt &&
                  boundary === "pre-did" &&
                  attempt.step === "reserve-signing-key"
                ) {
                  interrupt = false;
                  throw Error("Fixture interruption");
                }
              },
              async checkpoint(claim, input) {
                if (
                  interrupt &&
                  boundary === "locally-complete" &&
                  input.phase === "complete"
                ) {
                  interrupt = false;
                  throw Error("Fixture interruption");
                }
                return store.checkpoint(claim, input);
              },
            },
          });
        },
      });
      await assert.rejects(f.accounts.create(alice), /Fixture interruption/);
      holdContinuation = true;
      const reconciling = f.accounts.reconcile();
      await admitted.promise;
      // create() installs its matching local promise before yielding. That promise
      // is queued behind the reconciliation claim deliberately held above.
      const publicRequest = f.accounts.create(alice);
      release.resolve();
      const [reconciled, account] = await Promise.all([
        reconciling,
        publicRequest,
      ]);
      assert.equal(account.status, "active");
      assert.ok(
        reconciled.some(
          (row) =>
            row.id === `create:${account.did}` && row.status === "complete",
        ),
      );
      for (const method of ["reserveSigningKey", "createAccount"])
        assert.equal(
          f.calls.filter(
            (call) => call.method === `com.atproto.server.${method}`,
          ).length,
          1,
        );
    },
  );

test("a paused pre-DID scheduler cannot allocate or dispatch after its nominated admission is retired", async (t) => {
  let interrupt = true;
  let pauseNomination = false;
  const nominated = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await fixture(t, undefined, {
    ownershipFactory: (db) => {
      const store = createOperationOwnershipStore(db);
      return createOperationOwnership({
        store: {
          ...store,
          async acknowledgeExternal(claim, attempt, result) {
            await store.acknowledgeExternal(claim, attempt, result);
            if (interrupt && attempt.step === "reserve-signing-key") {
              interrupt = false;
              throw Error("Fixture interruption");
            }
          },
          async pendingIntentId(...input) {
            const id = await store.pendingIntentId(...input);
            if (pauseNomination) {
              pauseNomination = false;
              nominated.resolve(id);
              await release.promise;
            }
            return id;
          },
        },
      });
    },
  });
  await assert.rejects(f.accounts.create(alice), /Fixture interruption/);
  pauseNomination = true;
  const scheduler = f.accounts.reconcileRegistrations();
  const operationId = await nominated.promise;
  assert.ok(operationId);
  const intent = { kind: "create", request: { ...alice, recoveryKey: null } };
  await f.accounts.ownership.resumeAcknowledged(
    `email:${alice.email}`,
    operationId,
    intent,
    async () => {
      await f.accounts.ownership.checkpoint(
        "registration-validation-failed",
        null,
        false,
      );
    },
  );
  const writes = f.calls.length;
  release.resolve();
  const result = await scheduler;
  assert.equal(result[0].error, "OperationNoLongerPending");
  assert.equal(f.calls.length, writes);
  assert.equal(await f.accounts.get(alice.email), null);
  assert.equal(await f.accounts.pendingRegistration(alice.email), null);
  const changed = await f.accounts.create({
    ...alice,
    handle: "new-intent.entryway.atmosbox.test",
  });
  assert.equal(changed.handle, "new-intent.entryway.atmosbox.test");
});
