import assert from "node:assert/strict";
import { test } from "node:test";
import { createConsent } from "../../../dist/src/features/oauth-authorization/consent.mjs";

function consentFor(status) {
  const pages = [];
  const linked = [];
  const { authenticated } = createConsent({
    pendingArrival: { isPending: async () => false },
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
  // The reactivation link opens the account console, which requires this
  // browser's fresh device membership for the selected DID.
  assert.deepEqual(linked, [
    { deviceId: "browser", did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" },
  ]);
  assert.equal(pages[0].statusCode, 403);
  assert.match(pages[0].body, /reactivate/);
});

test("a pending incoming arrival is never offered reactivation and authorizes nothing", async () => {
  const pages = [];
  const { authenticated } = createConsent({
    // The real predicate is built from saved arrival facts; here a pending
    // arrival is the `provisioning` row.
    pendingArrival: { isPending: async (row) => row.status === "provisioning" },
    db: { transact: (operation) => operation(), delete: async () => {} },
    provider: {
      accountManager: { upsertDeviceAccount: async () => {} },
    },
    stores: { account: async () => null },
    accountAccess: {
      requireBoundAccount: async (_identity, did) => ({
        did,
        status: "provisioning",
      }),
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
  await sign(authenticated, "provisioning");
  assert.equal(pages.length, 1);
  assert.equal(pages[0].statusCode, 409);
  assert.equal(pages[0].title, "Migration in progress");
  assert.match(pages[0].body, /unfinished incoming migration/);
  assert.doesNotMatch(pages[0].body, /reactivate this|Open account settings/);
});

test("consent describes parsed permissions and retains exact unknown scopes", () => {
  const { consentForm } = createConsent({ flows: {} });
  const html = consentForm(
    {
      id: "flow",
      clientName: "<client>",
      authUserId: "user",
      parameters: {
        scope:
          "atproto repo:app.bsky.feed.post?action=create rpc:com.example.write?aud=* unknown:scope",
      },
    },
    { csrf: "token" },
    { did: "did:plc:example", handle: "owner.example" },
  );
  assert.match(
    html,
    /Permitted record actions: create in app\.bsky\.feed\.post/,
  );
  assert.match(html, /Call com\.example\.write on \*/);
  assert.match(html, /unknown:scope/);
  assert.match(html, /Review the exact permission requested below/);
  assert.match(html, /&lt;client(?:&gt;|>)/);
  assert.doesNotMatch(html, /<client>/);
  for (const value of ["approve", "deny"])
    assert.match(html, new RegExp(`name="decision" value="${value}"`));
});

test("consent identifies a nameless client and explains broad transitional access", () => {
  const { consentForm } = createConsent({ flows: {} });
  const html = consentForm(
    {
      id: "flow",
      clientName: "",
      clientId: "https://client.example/metadata?x=1&y=2",
      parameters: { scope: "atproto transition:generic" },
    },
    { csrf: "token" },
    { did: "did:plc:example", handle: "owner.example" },
  );
  assert.match(html, /https:\/\/client\.example\/metadata\?x=1&amp;y=2/);
  assert.match(html, /transition:generic/);
  assert.match(html, /Create, update, and delete any repository records/);
  assert.match(html, /upload media, read and change preferences/);
  assert.match(html, /most services except chat/);
  assert.match(html, /does not include account management/);
  assert.doesNotMatch(html, /Your application/);
});

test("consent explains transitional chat access and retains its exact scope", () => {
  const { consentForm } = createConsent({ flows: {} });
  const html = consentForm(
    {
      id: "flow",
      clientId: "https://client.example",
      parameters: { scope: "atproto transition:chat.bsky" },
    },
    { csrf: "token" },
    { did: "did:plc:example", handle: "owner.example" },
  );
  assert.match(html, /transition:chat\.bsky/);
  assert.match(html, /Call chat\.bsky service methods\./);
});
