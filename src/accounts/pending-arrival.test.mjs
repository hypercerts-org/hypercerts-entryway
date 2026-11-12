import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import * as plc from "@did-plc/lib";
import { createServiceJwt } from "@atproto/xrpc-server";
import {
  fixture,
  admitProvisioning,
  email,
  handle,
} from "../../tests/support/helpers/incoming-arrival-fixture.mjs";
import { query } from "../../tests/support/database-fixture.mjs";
import {
  createPendingArrivalGuard,
  permittedWhilePending,
  refusedWhilePending,
} from "../../dist/src/accounts/pending-arrival.js";
import { createAccountPrimitives } from "../../dist/src/accounts/primitives.mjs";
import { createStatusChange } from "../../dist/src/features/account-settings/change-status.mjs";
import { createRegistration } from "../../dist/src/features/account-registration/create-account.js";
import { createSignupForm } from "../../dist/src/features/account-registration/page.mjs";
import { createCustodyInventoryStorage } from "../../dist/src/database/drizzle/migration-custody.js";
import { createProtocolRouting } from "../../dist/src/http/protocol-authentication.mjs";
import { createAccountConsole } from "../../dist/src/http/account-console.mjs";
import { incomingCreationMethod } from "../../dist/src/features/external-migration/incoming-authorization.js";

const codeOf = (error) => error.code ?? error.error;
const hasCode = (code, status) => (error) =>
  codeOf(error) === code && (status === undefined || error.status === status);

/** A bound, paused, tracked-credential arrival: the state every guard protects. */
async function pending(t) {
  const f = await fixture(t);
  const prepared = await admitProvisioning(f);
  const result = await f.composed.continueCreation(
    f.request,
    prepared.operationId,
  );
  const session = await f.composed.issueArrivalSession(
    f.request,
    prepared.operationId,
    result.version,
  );
  return { f, prepared, session };
}

test("the action set is explicit, disjoint and deny-by-default", async () => {
  const guard = createPendingArrivalGuard({
    hasPendingExternalMigration: async () => true,
  });
  const row = {
    did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    status: "provisioning",
  };
  assert.equal(
    permittedWhilePending.some((action) =>
      refusedWhilePending.includes(action),
    ),
    false,
  );
  assert.deepEqual([...permittedWhilePending].sort(), [
    "arrival-activation",
    "arrival-continuation",
    "arrival-credential-recovery",
    "arrival-credential-refresh",
    "arrival-status",
  ]);
  for (const action of permittedWhilePending)
    await guard.assertPermitted(row, action);
  for (const action of refusedWhilePending)
    await assert.rejects(
      guard.assertPermitted(row, action),
      hasCode("MigrationPending", 409),
      action,
    );
  // An action nobody reviewed is refused, not allowed.
  await assert.rejects(
    guard.assertPermitted(row, "some-new-ordinary-action"),
    hasCode("MigrationPending", 409),
  );
});

test("the guard reads saved arrival facts, never the status alone", async () => {
  const none = createPendingArrivalGuard({
    hasPendingExternalMigration: async () => false,
  });
  const unfinishedSignup = {
    did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    status: "provisioning",
  };
  assert.equal(await none.isPending(unfinishedSignup), false);
  await none.assertPermitted(unfinishedSignup, "registration");
  const some = createPendingArrivalGuard({
    hasPendingExternalMigration: async () => true,
  });
  assert.equal(
    await some.isPending({ ...unfinishedSignup, status: "active" }),
    false,
  );
  assert.equal(await some.isPending(null), false);
  assert.equal(await some.isPending(unfinishedSignup), true);
});

test("ordinary setStatus cannot activate or deactivate a pending arrival", async (t) => {
  const { f } = await pending(t);
  const primitives = createAccountPrimitives({
    db: f.db,
    config: f.config,
    storage: f.storage,
    ownership: f.ownership,
  });
  let adminCalls = 0;
  const setStatus = createStatusChange({
    db: f.db,
    get: primitives.get,
    save: primitives.save,
    journal: primitives.journal,
    serialized: primitives.serialized,
    assertNoMigration: primitives.assertNoMigration,
    admin: async () => {
      adminCalls++;
    },
  });
  for (const status of ["active", "deactivated"])
    await assert.rejects(
      setStatus(f.did, status),
      hasCode("MigrationPending", 409),
      status,
    );
  assert.equal(adminCalls, 0);
  assert.equal(f.backendState.activations, 0);
  assert.equal(
    (await query(f.db, "SELECT status FROM accounts"))[0].status,
    "provisioning",
  );
  assert.equal((await f.arrivals.readArrivalAccess(f.did)).complete, false);
  await assert.rejects(
    primitives.assertNoMigration(f.did),
    hasCode("MigrationPending", 409),
  );
});

test("after the one activation the same operations apply to an ordinary account", async (t) => {
  const { f, session } = await pending(t);
  await f.composed.activateArrivalWithCredential(session.accessJwt);
  const primitives = createAccountPrimitives({
    db: f.db,
    config: f.config,
    storage: f.storage,
    ownership: f.ownership,
  });
  await primitives.assertNoMigration(f.did);
});

test("ordinary registration for a pending arrival's email is refused", async (t) => {
  const { f } = await pending(t);
  const primitives = createAccountPrimitives({
    db: f.db,
    config: f.config,
    storage: f.storage,
    ownership: f.ownership,
  });
  const registration = createRegistration({
    db: f.db,
    custody: createCustodyInventoryStorage(f.db),
    config: { ...f.config, plcRecoveryKeyDid: f.hot.did() },
    plcSigner: f.composed.accounts?.plcSigner ?? undefined,
    plcClient: undefined,
    storage: f.storage,
    save: primitives.save,
    claimHandle: primitives.claimHandle,
    validateHandle: async () => {},
    journal: primitives.journal,
    ownership: f.ownership,
  });
  await assert.rejects(
    registration.create({
      email,
      handle,
      pdsId: "pds1",
      registrationIdentity: {
        kind: "better-auth",
        userId: f.principal.userId,
        email,
      },
    }),
    hasCode("MigrationPending", 409),
  );
  assert.equal(
    (await query(f.db, "SELECT status FROM accounts"))[0].status,
    "provisioning",
  );
  assert.equal(f.backendState.activations, 0);
});

async function routing(f) {
  const app = express();
  return createProtocolRouting({
    app,
    db: f.db,
    config: f.config,
    accounts: {
      get: (did) => f.storage.getByDid(did),
      plcClient: {
        getDocument: async () =>
          plc.formatDidDoc({
            did: f.did,
            ...plc.normalizeOp(f.audit.at(-1).operation),
          }),
      },
    },
    accountAccess: {},
    oauth: {},
    legacy: f.legacy,
  });
}
const attempt = (authenticate, nsid, authorization, body = {}) =>
  authenticate(
    { headers: { authorization }, body, res: { set() {} }, method: "POST" },
    nsid,
  );

test("protocol authentication refuses a pending arrival's tracked credential and every service JWT", async (t) => {
  const { f, session } = await pending(t);
  const { authenticate } = await routing(f);
  // The tracked access credential is not an ordinary account credential.
  for (const nsid of [
    "com.atproto.server.getSession",
    "com.atproto.server.activateAccount",
    "com.atproto.server.deactivateAccount",
    "com.atproto.identity.submitPlcOperation",
  ])
    await assert.rejects(
      attempt(authenticate, nsid, `Bearer ${session.accessJwt}`),
      hasCode("AccountUnavailable", 403),
      nsid,
    );
  // A service JWT signed by the destination repository key verifies, but names
  // no active hosted account: never managed movement or hosted authority.
  const now = Math.floor(Date.now() / 1000);
  for (const nsid of [
    incomingCreationMethod,
    "com.atproto.identity.submitPlcOperation",
    "com.atproto.server.deactivateAccount",
  ]) {
    const token = await createServiceJwt({
      iss: f.did,
      aud: f.config.serviceDid,
      lxm: nsid,
      keypair: f.repository,
      exp: now + 60,
    });
    await assert.rejects(
      attempt(authenticate, nsid, `Bearer ${token}`, { did: f.did }),
      hasCode("AccountNotFound", 401),
      nsid,
    );
  }
});

test("ordinary refresh refuses a pending arrival's family without revoking it", async (t) => {
  const { f, session } = await pending(t);
  await assert.rejects(
    f.legacy.refreshSession(`Bearer ${session.refreshJwt}`),
    hasCode("AccountUnavailable", 403),
  );
  // Still the tracked family's credential for the arrival's own refresh.
  const refreshed = await f.composed.refreshArrivalSession(session.refreshJwt);
  assert.equal(refreshed.active, false);
});

test("the account console shows a pending arrival an honest page, never settings", async (t) => {
  const { f } = await pending(t);
  const pages = [];
  const console_ = createAccountConsole({
    app: express(),
    accounts: { storage: f.storage },
    accountAccess: {
      resolveBoundAccounts: async () => ({
        kind: "single",
        account: await f.storage.getByDid(f.did),
      }),
      requireBoundAccount: async () => f.storage.getByDid(f.did),
    },
    oauth: {
      requireSession: async () => ({ ...f.principal, emailVerified: true }),
      loadBrowser: async () => ({ deviceId: "d", csrf: "c" }),
      checkCsrf() {},
      provider: { accountManager: { listDeviceAccounts: async () => [] } },
    },
    security: {},
    legacy: {},
  });
  const result = await console_.authenticated(
    { method: "GET", query: {}, headers: {} },
    {
      locals: {},
      set() {},
      status(code) {
        pages.push(code);
        return this;
      },
      type() {
        return this;
      },
      send(html) {
        pages.push(html);
      },
    },
  );
  assert.equal(result, null);
  assert.equal(pages[0], 409);
  assert.match(pages[1], /unfinished incoming migration/);
  assert.doesNotMatch(pages[1], /Reactivate|Deactivate|Delete/);
});

test("the signup form never offers to retry or complete a pending arrival", async (t) => {
  const { f } = await pending(t);
  const signupForm = createSignupForm({
    db: f.db,
    config: f.config,
    accounts: {
      storage: f.storage,
      ownership: f.ownership,
      get: (did) => f.storage.getByDid(did),
      pendingRegistration: async () => null,
    },
    fields: () => "",
  });
  const html = await signupForm({ authEmail: email }, { csrf: "c" });
  assert.match(html, /unfinished incoming migration/);
  assert.doesNotMatch(html, /Retry account setup|Create account|<form/);
});
