import test from "node:test";
import assert from "node:assert/strict";
import {
  queryConnectedApps,
  endBrowserSession,
  forgetDevice,
  revokeGrant,
  revokeAppAccess,
} from "../../../dist/src/features/connected-apps/operations.js";

function fixture() {
  const sessions = [
    { id: "browser-a", userAgent: "agent", createdAt: 1, token: "secret" },
    { id: "browser-b", createdAt: 2 },
  ];
  const grants = new Map([
    [
      "did:a",
      new Map([
        ["client:a", { authorizedScopes: ["read"], secret: "hidden" }],
        ["client:b", {}],
      ]),
    ],
    ["did:b", new Map([["client:a", {}]])],
  ]);
  const devices = new Set([
    "device:shared/did:a",
    "device:shared/did:b",
    "device:other/did:a",
  ]);
  const tokens = [
    {
      id: "token-a",
      data: { clientId: "client:a", createdAt: 1, secret: "hidden" },
      currentRefreshToken: "secret",
    },
  ];
  const oauth = {
    listBrowserSessions: async () => sessions,
    revokeBrowserSession: async (_req, id) => {
      sessions.splice(
        sessions.findIndex((item) => item.id === id),
        1,
      );
    },
    stores: {
      listAccountTokens: async () => tokens,
      listAccountGrants: async (did) => [...(grants.get(did) ?? [])],
      listDeviceAccounts: async ({ did }) =>
        [...devices]
          .filter((key) => key.endsWith(`/${did}`))
          .map((key) => ({
            deviceId: key.split("/")[0],
            updatedAt: 1,
            secret: "hidden",
          })),
      removeDeviceAccount: async (device, did) =>
        devices.delete(`${device}/${did}`),
      revokeClientGrant: async (did, client) =>
        grants.get(did)?.delete(client) ?? false,
      revokeAllGrants: async (did) => {
        grants.delete(did);
      },
    },
  };
  return { oauth, sessions, grants, devices };
}

test("query returns only display fields and scoped commands preserve siblings", async () => {
  const { oauth, sessions, grants, devices } = fixture();
  const result = await queryConnectedApps({ oauth }, {}, "did:a");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.deepEqual(
    result.grants.map(([id]) => id),
    ["client:a", "client:b"],
  );
  assert.equal(await endBrowserSession(oauth, {}, "foreign"), false);
  assert.equal(await endBrowserSession(oauth, {}, "browser-a"), true);
  assert.deepEqual(
    sessions.map(({ id }) => id),
    ["browser-b"],
  );
  assert.equal(await forgetDevice(oauth, "did:a", "missing"), false);
  assert.equal(await forgetDevice(oauth, "did:a", "device:shared"), true);
  assert.equal(devices.has("device:shared/did:b"), true);
  assert.equal(devices.has("device:other/did:a"), true);
  assert.equal(await revokeGrant(oauth, "did:a", "missing"), false);
  assert.equal(await revokeGrant(oauth, "did:a", "client:a"), true);
  assert.equal(grants.get("did:a").has("client:b"), true);
  assert.equal(grants.get("did:b").has("client:a"), true);
  await revokeAppAccess({ oauth }, "did:a");
  assert.equal(grants.has("did:a"), false);
  assert.equal(grants.has("did:b"), true);
});

test("account actions dispatch selected DID and preserve current-session redirect", async () => {
  const { createConnectedAppsActions } =
    await import("../../../dist/src/features/connected-apps/actions.mjs");
  const { oauth, grants, devices } = fixture();
  const actions = createConnectedAppsActions({ oauth });
  const action = (key, values, extra = {}) =>
    actions[key]({
      account: { did: "did:a" },
      value: (name) => values[name],
      ...extra,
    });
  await assert.rejects(action("grant-revoke", { clientId: "foreign" }), {
    status: 404,
  });
  await action("grant-revoke", { clientId: "client:a" });
  assert.equal(grants.get("did:b").has("client:a"), true);
  await action("device-revoke", { deviceId: "device:shared" });
  assert.equal(devices.has("device:shared/did:b"), true);
  let redirect;
  await action(
    "browser-session-revoke",
    { sessionId: "browser-a" },
    {
      req: {},
      session: { sessionId: "browser-a" },
      res: {
        redirect: (...args) => {
          redirect = args;
        },
      },
    },
  );
  assert.deepEqual(redirect, [303, "/login"]);
});

test("app password issuance checks the live binding and recent proof within its transaction", async () => {
  const { createConnectedAppsActions } =
    await import("../../../dist/src/features/connected-apps/actions.mjs");
  let inTransaction = false;
  let bound = true;
  let recent = true;
  const issued = [];
  const actions = createConnectedAppsActions({
    db: {
      async transact(run) {
        inTransaction = true;
        try {
          return await run();
        } finally {
          inTransaction = false;
        }
      },
    },
    accounts: {
      async serialized(_did, run) {
        return run();
      },
    },
    accountAccess: {
      async requireBoundAccount(_session, did) {
        assert.equal(inTransaction, true);
        if (!bound) throw Error("AccountMismatch");
        assert.equal(did, "did:a");
      },
    },
    security: {
      async summary() {
        assert.equal(inTransaction, true);
      },
      async isRecent() {
        assert.equal(inTransaction, true);
        return recent;
      },
    },
    legacy: {
      async createAppPassword(did, input) {
        assert.equal(inTransaction, true);
        issued.push({ did, ...input });
        return { ...input, password: "synthetic" };
      },
    },
    console: { needed() {} },
  });
  const invoke = () =>
    actions["app-password-create"]({
      req: { body: {} },
      res: {
        set() {},
        type() {
          return this;
        },
        status() {
          return this;
        },
        send() {},
      },
      account: { did: "did:a" },
      session: {},
      principal: {},
      value: () => "example",
    });
  bound = false;
  await assert.rejects(invoke(), /AccountMismatch/);
  bound = true;
  recent = false;
  await assert.rejects(invoke(), { error: "ReauthenticationRequired" });
  assert.deepEqual(issued, []);
  recent = true;
  await invoke();
  assert.deepEqual(issued, [
    { did: "did:a", name: "example", privileged: false },
  ]);
});
