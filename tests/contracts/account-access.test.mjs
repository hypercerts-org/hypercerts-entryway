import assert from "node:assert/strict";
import test from "node:test";
import { createAccountAccess } from "../../dist/src/accounts/account-access.mjs";

const identity = {
  userId: "verified-user",
  email: "owner@example.test",
  emailVerified: true,
};

const account = (did, handle) => ({
  did,
  email: identity.email,
  handle,
  pdsId: "pds1",
  pdsUrl: "https://pds1.example.test",
  recoveryKey: "did:key:private-account-metadata",
  status: "active",
});

function reader(rows) {
  return {
    async isVerifiedUserEmail({ userId, email }) {
      return userId === identity.userId && email === identity.email;
    },
    async listBoundAccounts(userId) {
      assert.equal(userId, identity.userId);
      return rows;
    },
  };
}

test("unbound verified identity cannot select an account by email or DID", async () => {
  const access = createAccountAccess(reader([]));

  assert.deepEqual(await access.resolveBoundAccounts(identity), {
    kind: "unbound",
  });
  await assert.rejects(
    access.requireBoundAccount(identity, "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"),
    { code: "AccountMismatch" },
  );
});

test("a bound identity resolves its one established account", async () => {
  const owned = account("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "one.example.test");
  const access = createAccountAccess(reader([owned]));

  assert.deepEqual(await access.resolveBoundAccounts(identity), {
    kind: "single",
    account: owned,
  });
  assert.deepEqual(
    await access.requireBoundAccount(identity, owned.did),
    owned,
  );
});

test("multiple bindings require an explicit DID and expose only safe summaries", async () => {
  const first = account("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "one.example.test");
  const second = account("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb", "two.example.test");
  const access = createAccountAccess(reader([first, second]));

  assert.deepEqual(await access.resolveBoundAccounts(identity), {
    kind: "selection-required",
    accounts: [
      {
        did: first.did,
        handle: first.handle,
        status: "active",
      },
      {
        did: second.did,
        handle: second.handle,
        status: "active",
      },
    ],
  });
  assert.deepEqual(
    await access.requireBoundAccount(identity, second.did),
    second,
  );
  await assert.rejects(
    access.requireBoundAccount(identity, "did:plc:cccccccccccccccccccccccc"),
    { code: "AccountMismatch" },
  );
});

test("an unverified browser identity cannot resolve account bindings", async () => {
  let read = false;
  const access = createAccountAccess({
    async isVerifiedUserEmail() {
      read = true;
      return true;
    },
    async listBoundAccounts() {
      read = true;
      return [];
    },
  });

  await assert.rejects(
    access.resolveBoundAccounts({ ...identity, emailVerified: false }),
    { code: "AccountMismatch" },
  );
  assert.equal(read, false);
});

test("a browser proof no longer backed by a verified database email cannot resolve bindings", async () => {
  let readBindings = false;
  const access = createAccountAccess({
    async isVerifiedUserEmail() {
      return false;
    },
    async listBoundAccounts() {
      readBindings = true;
      return [account("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "one.example.test")];
    },
  });

  await assert.rejects(access.resolveBoundAccounts(identity), {
    code: "AccountMismatch",
  });
  assert.equal(readBindings, false);
});
