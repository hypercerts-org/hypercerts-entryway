import assert from "node:assert/strict";
import { test } from "node:test";
import { createConsent } from "../../../dist/src/features/oauth-authorization/consent.mjs";

function consentFor(status) {
  const pages = [];
  const linked = [];
  const { authenticated } = createConsent({
    db: { transact: (operation) => operation(), delete: async () => {} },
    provider: {
      accountManager: {
        async upsertDeviceAccount(deviceId, did) {
          linked.push({ deviceId, did });
        },
      },
    },
    stores: { account: async () => null },
    accountAccess: {
      async requireBoundAccount(_identity, did) {
        return { did, handle: "owner.example.test", status };
      },
    },
    flows: {
      fields: () => "",
      save: async () => {},
      readCurrentIntent: async (flow) => ({ ...flow }),
      pageForFlow: (_res, title, body, _flow, statusCode) => {
        pages.push({ title, body, statusCode });
      },
    },
  });
  return { authenticated, pages, linked };
}

const sign = (authenticated, status) => {
  let cookies = 0;
  const row = { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", status };
  const done = authenticated(
    {},
    { redirect() {} },
    { id: "flow", requestUri: "request" },
    { deviceId: "browser" },
    row,
    {
      identity: { email: "Owner@Example.test", userId: "user" },
      commitCookies: () => {
        cookies++;
      },
    },
  );
  return done.then(() => cookies);
};

test("deleted bound account gets no browser session and no reactivation prompt", async () => {
  const { authenticated, pages, linked } = consentFor("deleted");
  assert.equal(await sign(authenticated, "deleted"), 0);
  assert.deepEqual(linked, []);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].statusCode, 403);
  assert.match(pages[0].body, /deleted and cannot be used/);
  assert.doesNotMatch(pages[0].body, /reactivate/);
});

test("deactivated bound account keeps its session and reactivation path", async () => {
  const { authenticated, pages, linked } = consentFor("deactivated");
  assert.equal(await sign(authenticated, "deactivated"), 1);
  assert.deepEqual(linked, []);
  assert.equal(pages[0].statusCode, 403);
  assert.match(pages[0].body, /reactivate/);
});
