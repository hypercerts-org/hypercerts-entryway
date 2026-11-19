import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  call,
  errorName,
  expectDestinationServes,
  expectInventoryRetained,
  json,
  malformedCars,
  ok,
  registerArrivalSetup,
} from "../support/helpers/incoming-journey.mjs";
import {
  expectSdkAction,
  expectSdkWrite,
  expectSourceCutover,
} from "../support/helpers/incoming-post-move.mjs";
import {
  verifyRepoCar,
  verifyCommitSig,
  readCarWithRoot,
  MemoryBlockstore,
  def,
  ensureV3Commit,
} from "@atproto/repo";
import { Secp256k1Keypair } from "@atproto/crypto";
import { waitForStockPlcMessage } from "../support/helpers/stock-plc-mailpit.mjs";
import { nodeRouting } from "../support/helpers/incoming-nodes.mjs";

// Public incoming-migration journey, run only by `./tests/local.sh
// incoming-public-journey` (one shape) or `incoming-public-shapes` (four) inside
// an owned sandbox. Entryway is reached only
// through its public browser pages and XRPC routes. The source is the standalone
// stock PDS, the destination is a stock PDS behind Entryway, mail is read from
// Mailpit, and nothing seeds authority rows or calls a private fixture. The
// client chooses what to transfer and when to activate; this does not certify
// completeness of every record or blob.
//
// `./tests/local.sh fresh-group incoming-two-node` runs the same journey on the
// two-node PostgreSQL profile (`INCOMING_TWO_NODE=1`), once per node order. Each
// Entryway-facing stage is then pinned to one node with `x-profile-node` and
// must be served by that node's instance; see `incoming-nodes.mjs`. Otherwise
// the routing helper does nothing.
const twoNode = process.env.INCOMING_TWO_NODE === "1";
// Read in beforeAll so test discovery works without a sandbox.
let access;
let config;
let sdk;
let confidential;
let nodes;
const unique = randomUUID().replaceAll("-", "").slice(0, 16);
const destinationEmail = `public-arrival-${unique}@example.com`;
const sourceEmail = `public-source-${unique}@example.com`;
const handoffMethod = "com.atproto.identity.submitPlcOperation";
const creationMethod = "com.atproto.server.createAccount";
const run = {};
// Generated per run and never logged: the migrated account password and the
// public did:key of a recovery keypair the test holds.
const destinationPassword = `Arrive-${randomUUID()}-${randomUUID()}`;

// Stock service tokens last about a minute, so each is minted right before use.
const serviceAuth = async (lxm) =>
  json(
    await call(access.sourceUrl, "com.atproto.server.getServiceAuth", {
      token: run.source.accessJwt,
      params: { aud: config.serviceDid, lxm },
    }),
  ).token;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  sdk = await import("../support/helpers/browser-oauth.mjs");
  confidential = await import("./support/oauth-client.mjs");
  access = JSON.parse(readFileSync(process.env.INCOMING_ACCESS_PATH, "utf8"));
  assert.equal(access.project, process.env.INCOMING_PROJECT);
  config = JSON.parse(readFileSync(process.env.SERVICE_CONFIG_PATH, "utf8"));
  const order = test.info().project.metadata.nodes;
  assert.equal(Array.isArray(order), twoNode, "node order only on two nodes");
  nodes = nodeRouting(config.issuer, order);
  await nodes.load();
});

registerArrivalSetup(test, {
  context: () => ({ access, config }),
  run,
  unique,
  sourceEmail,
  sourcePassword: `Public-${randomUUID()}!`,
  destinationEmail,
  displayName: "Public arrival journey",
  aroundPrepare: (page, prepare) =>
    nodes.stage("prepare", 0, run.source.did, prepare, { page }),
});

test("the client verifies the source export before identity cutover", async () => {
  const did = run.source.did;
  const head = await fetch(new URL(`/${did}/data`, access.plcUrl));
  expect(head.status).toBe(200);
  const key = (await head.json()).verificationMethods.atproto;
  const exported = await call(access.sourceUrl, "com.atproto.sync.getRepo", {
    params: { did },
  });
  ok(exported, "source export");
  run.car = exported.content;
  const verified = await verifyRepoCar(run.car, did);
  expect(
    verified.creates
      .map(
        ({ collection, rkey, cid }) =>
          `at://${did}/${collection}/${rkey} ${cid}`,
      )
      .sort(),
  ).toEqual(
    run.inventory.records.map(({ uri, cid }) => `${uri} ${cid}`).sort(),
  );
  const car = await readCarWithRoot(run.car);
  const commit = ensureV3Commit(
    await new MemoryBlockstore(car.blocks).readObj(
      car.root,
      def.versionedCommit,
    ),
  );
  expect(await verifyCommitSig(commit, key)).toBe(true);
});

test("the source signs the authority handoff and Entryway publishes only that", async () => {
  // Stock service tokens last about a minute: the creation token is minted
  // immediately before it is used, not here.
  const since = Date.now();
  ok(
    await call(
      access.sourceUrl,
      "com.atproto.identity.requestPlcOperationSignature",
      { token: run.source.accessJwt },
    ),
    "plc confirmation",
  );
  const confirmation = await waitForStockPlcMessage({
    recipient: sourceEmail,
    since,
    excludeIds: [],
    baseUrl: access.mailpitUrl,
  });
  const signed = await call(
    access.sourceUrl,
    "com.atproto.identity.signPlcOperation",
    {
      token: run.source.accessJwt,
      body: {
        token: confirmation.token,
        rotationKeys: run.prepared.handoff.rotationKeys,
        alsoKnownAs: run.prepared.handoff.alsoKnownAs,
        verificationMethods: run.prepared.handoff.verificationMethods,
        services: run.prepared.handoff.services,
      },
    },
  );
  ok(signed, "signed handoff");
  const operation = json(signed).operation;
  await nodes.stage("handoff", 1, run.source.did, async () => {
    // Wrong code, then wrong method, are refused before anything is published.
    const wrongCode = await fetch(
      new URL(`/xrpc/${handoffMethod}`, config.issuer),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await serviceAuth(handoffMethod)}`,
          "entryway-arrival-code": "A".repeat(32),
          "content-type": "application/json",
          ...nodes.headers(1),
        },
        body: JSON.stringify({ operation }),
      },
    );
    nodes.expectServed(wrongCode, "wrong-code handoff");
    expect(wrongCode.status).toBe(409);
    expect((await wrongCode.json()).error).toBe("ArrivalExpired");
    const wrongMethodJwt = await serviceAuth(creationMethod);
    const wrongMethod = await fetch(
      new URL(`/xrpc/${handoffMethod}`, config.issuer),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${wrongMethodJwt}`,
          "entryway-arrival-code": run.prepared.arrivalCode,
          "content-type": "application/json",
          ...nodes.headers(1),
        },
        body: JSON.stringify({ operation }),
      },
    );
    nodes.expectServed(wrongMethod, "wrong-method handoff");
    expect(wrongMethod.status).toBe(403);
    const submitted = await fetch(
      new URL(`/xrpc/${handoffMethod}`, config.issuer),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await serviceAuth(handoffMethod)}`,
          "entryway-arrival-code": run.prepared.arrivalCode,
          "content-type": "application/json",
          ...nodes.headers(1),
        },
        body: JSON.stringify({ operation }),
      },
    );
    nodes.expectServed(submitted, "handoff");
    expect(submitted.status).toBe(200);
    expect(submitted.headers.get("cache-control")).toBe("no-store");
  });
  // createAccount publishes a second operation. Read the head before creation.
  const head = await fetch(
    new URL(`/${run.source.did}/log/last`, access.plcUrl),
  );
  expect(head.status).toBe(200);
  expect(
    isDeepStrictEqual(await head.json(), operation),
    "exact signed PLC handoff",
  ).toBe(true);
});

test("creation returns tracked credentials for a paused destination", async () => {
  await nodes.stage("createAccount", 0, run.source.did, createDestination);
});

async function createDestination() {
  const headers = {
    authorization: `Bearer ${await serviceAuth(creationMethod)}`,
    "entryway-arrival-code": run.prepared.arrivalCode,
    "content-type": "application/json",
    ...nodes.headers(0),
  };
  run.recoveryKey = (await Secp256k1Keypair.create()).did();
  const body = {
    handle: run.destinationHandle,
    password: destinationPassword,
    recoveryKey: run.recoveryKey,
  };
  if (config.inviteCodeRequired) {
    const invite = await fetch(
      new URL("/xrpc/com.atproto.server.createInviteCode", config.issuer),
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`admin:${config.adminPassword}`).toString("base64")}`,
          "content-type": "application/json",
          ...nodes.headers(0),
        },
        body: JSON.stringify({ useCount: 1 }),
      },
    );
    expect(invite.status).toBe(200);
    body.inviteCode = (await invite.json()).code;
  }
  const created = await fetch(
    new URL(`/xrpc/${creationMethod}`, config.issuer),
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
  nodes.expectServed(created, "createAccount");
  expect(created.status).toBe(200);
  expect(created.headers.get("cache-control")).toBe("no-store");
  run.destination = await created.json();
  expect(run.destination.did).toBe(run.source.did);
  expect(run.destination.handle).toBe(run.destinationHandle);
  expect(run.destination.active).toBe(false);
  // An exact replay cannot mint another family once credentials were issued.
  const repeated = await fetch(
    new URL(`/xrpc/${creationMethod}`, config.issuer),
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
  nodes.expectServed(repeated, "createAccount replay");
  expect(repeated.status).toBe(409);
  expect((await repeated.json()).error).toBe("OperationConflict");
  // The paused destination refuses ordinary activation paths at Entryway.
  const plain = await fetch(
    new URL("/xrpc/com.atproto.server.getSession", config.issuer),
    {
      headers: {
        authorization: `Bearer ${run.destination.accessJwt}`,
        ...nodes.headers(0),
      },
    },
  );
  nodes.expectServed(plain, "paused getSession");
  expect(plain.status).toBeGreaterThanOrEqual(400);
}

// Observed on the pinned stock destination (@atproto/pds 0.5.36). Each refusal
// must leave the paused destination's status and its own export byte-identical.
// The two 500s are not an integrity-specific status: while importRepo reads the
// body, @atproto/repo's verifyIncomingCarBlocks throws a plain Error ("Not a
// valid CID for bytes"), which xrpc-server surfaces as a generic 500
// InternalServerError with the message hidden. They are pinned as a tripwire for
// a stock PDS upgrade, with the unchanged destination as the actual evidence.
async function expectMalformedImportsRefused() {
  const endpoint = run.prepared.destinationEndpoint;
  const token = run.destination.accessJwt;
  const did = run.source.did;
  const state = async () => {
    const status = await call(
      endpoint,
      "com.atproto.server.checkAccountStatus",
      { token },
    );
    ok(status, "destination status");
    const exported = await call(endpoint, "com.atproto.sync.getRepo", {
      token,
      params: { did },
    });
    ok(exported, "destination export");
    return { status: json(status), car: exported.content };
  };
  // Records are sorted by URI: a feed post where the shape has one, otherwise
  // the profile.
  const record = run.inventory.records.at(-1);
  const cars = await malformedCars(run.car, record);
  expect(cars.droppedBlock, "dropped block is the chosen record").toBe(
    record.cid,
  );
  const before = await state();
  expect(before.status.activated).toBe(false);
  expect(before.status.indexedRecords).toBe(0);
  expect((await verifyRepoCar(before.car, did)).creates).toEqual([]);
  for (const [name, bytes, refusal] of [
    [
      "a record block altered under its CID is refused",
      cars.tampered,
      { status: 500, error: "InternalServerError" },
    ],
    [
      "a CAR cut inside a block is refused",
      cars.cutMidBlock,
      { status: 500, error: "InternalServerError" },
    ],
    [
      "a CAR missing one record block is refused",
      cars.missingRecordBlock,
      { status: 400, error: "InvalidRequest" },
    ],
  ])
    await test.step(name, async () => {
      const response = await call(endpoint, "com.atproto.repo.importRepo", {
        token,
        bytes,
        type: "application/vnd.ipld.car",
      });
      expect({
        status: response.status,
        error: errorName(response),
      }).toEqual(refusal);
      const after = await state();
      expect(after.status).toEqual(before.status);
      expect(after.car.equals(before.car), "destination export unchanged").toBe(
        true,
      );
    });
}

test("the client transfers its chosen state directly between the pinned endpoints", async () => {
  const destinationRead = async (method) => {
    const response = await call(run.prepared.destinationEndpoint, method, {
      token: run.destination.accessJwt,
    });
    ok(response, method);
    return json(response);
  };
  // The per-PR default (blob-bearing) and the multi-collection shape probe the
  // stock import with malformed copies of the verified export first; the valid
  // import below is the control.
  if (
    ["blob-bearing", "multi-collection"].includes(
      test.info().project.metadata.shape ?? "blob-bearing",
    )
  )
    await expectMalformedImportsRefused();
  // The revision, not the commit CID: an import always writes a new revision.
  const { repoRev: revBefore } = await destinationRead(
    "com.atproto.server.checkAccountStatus",
  );
  expect(
    typeof revBefore === "string" && revBefore.length > 0,
    "destination revision before import",
  ).toBe(true);
  const imported = await call(
    run.prepared.destinationEndpoint,
    "com.atproto.repo.importRepo",
    {
      token: run.destination.accessJwt,
      bytes: run.car,
      type: "application/vnd.ipld.car",
    },
  );
  ok(imported, "destination import");
  for (const { cid, bytes } of run.inventory.blobs) {
    const pending = await destinationRead(
      "com.atproto.server.checkAccountStatus",
    );
    expect(pending.importedBlobs).toBeLessThan(pending.expectedBlobs);
    const missing = await destinationRead("com.atproto.repo.listMissingBlobs");
    expect(missing.blobs.map((blob) => blob.cid)).toContain(cid);
    ok(
      await call(
        run.prepared.destinationEndpoint,
        "com.atproto.repo.uploadBlob",
        {
          token: run.destination.accessJwt,
          bytes,
          type: "image/png",
        },
      ),
      "destination blob upload",
    );
  }
  const status = await destinationRead("com.atproto.server.checkAccountStatus");
  expect(status.expectedBlobs).toBe(run.inventory.blobs.length);
  expect(status.importedBlobs).toBe(status.expectedBlobs);
  expect(
    (await destinationRead("com.atproto.repo.listMissingBlobs")).blobs,
  ).toEqual([]);
  expect(status.activated).toBe(false);
  expect(status.repoCommit).toBeTruthy();
  expect(status.repoRev, "import wrote a new revision").not.toBe(revBefore);
});

test("the tracked credential refreshes, then activates through the stock destination callback", async () => {
  await nodes.stage("refresh", 1, run.source.did, async () => {
    const refreshed = await fetch(
      new URL("/xrpc/com.atproto.server.refreshSession", config.issuer),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${run.destination.refreshJwt}`,
          ...nodes.headers(1),
        },
      },
    );
    nodes.expectServed(refreshed, "refreshSession");
    expect(refreshed.status).toBe(200);
    run.destination = await refreshed.json();
    expect(run.destination.did).toBe(run.source.did);
  });
  // The stock destination forwards activation to Entryway itself, so the
  // ingress, not the test, picks the node: observed, not pinned.
  await nodes.observe(
    "activation",
    run.source.did,
    "/xrpc/com.atproto.server.activateAccount",
    async () =>
      ok(
        await call(
          run.prepared.destinationEndpoint,
          "com.atproto.server.activateAccount",
          { token: run.destination.accessJwt },
        ),
        "stock activateAccount",
      ),
  );
  const status = json(
    await call(
      run.prepared.destinationEndpoint,
      "com.atproto.server.checkAccountStatus",
      { token: run.destination.accessJwt },
    ),
  );
  expect(status.activated).toBe(true);
});

test("the activated account serves the transferred state and the client deactivates the source", async () => {
  await expectDestinationServes(access, {
    endpoint: run.prepared.destinationEndpoint,
    did: run.source.did,
    inventory: run.inventory,
    handle: run.destinationHandle,
  });
  // The recovery key leads the destination move, followed by the approved list.
  const data = await (
    await fetch(new URL(`/${run.source.did}/data`, access.plcUrl))
  ).json();
  expect(data.rotationKeys[0]).toBe(run.recoveryKey);
  expect(data.rotationKeys.slice(1)).toEqual(run.prepared.handoff.rotationKeys);
  // Ordinary password sign-in at Entryway works once the account is active.
  await nodes.stage("createSession", 0, run.source.did, async () => {
    for (const identifier of [run.destinationHandle, run.source.did]) {
      const session = await call(
        config.issuer,
        "com.atproto.server.createSession",
        {
          body: { identifier, password: destinationPassword },
          headers: nodes.headers(0),
        },
      );
      nodes.expectServed(session, "password createSession");
      expect(session.status, "password createSession status").toBe(200);
      expect(json(session).did).toBe(run.source.did);
    }
  });
  ok(
    await call(access.sourceUrl, "com.atproto.server.deactivateAccount", {
      token: run.source.accessJwt,
      body: {},
    }),
    "source deactivation",
  );
});

test("the tracked destination family refreshes as an active account session", async () => {
  await nodes.stage("family refresh", 1, run.source.did, async () => {
    const response = await fetch(
      new URL("/xrpc/com.atproto.server.refreshSession", config.issuer),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${run.destination.refreshJwt}`,
          ...nodes.headers(1),
        },
      },
    );
    nodes.expectServed(response, "family refreshSession");
    expect(response.status).toBe(200);
    expect((await response.json()).did).toBe(run.source.did);
  });
});

// Alternating instance IDs alone would not show one migration crossing nodes:
// each stage also names the one DID and continues the state the previous
// stage left on the other node.
if (twoNode)
  test("consecutive migration stages alternate Entryway nodes for one DID", async () => {
    nodes.expectAlternation(
      [
        "prepare",
        "handoff",
        "createAccount",
        "refresh",
        "createSession",
        "family refresh",
      ],
      run.source.did,
    );
    const activation = nodes.stages.filter(
      ({ stage }) => stage === "activation",
    );
    expect(activation.length).toBeGreaterThan(0);
    expect(activation.every(({ status }) => status === 200)).toBe(true);
    reportNodes();
  });

// The stage table goes to the private phase log, which the controller keeps:
// node names, instance IDs and paths only, no DID, credential or body. Each
// call prints the stages recorded since the previous one.
let reported = 0;
function reportNodes() {
  for (const stage of nodes.report().stages.slice(reported)) {
    const unpinned = (stage.unpinned ?? []).map(
      ({ method, path, node }) => `${method}:${path}@${node}`,
    );
    console.log(
      `node-stage stage=${stage.stage.replaceAll(" ", "-")} pinned=${stage.pinned} node=${stage.node} instance=${stage.instanceId}${stage.pinned ? ` requests=${stage.requests} unpinned=${unpinned.join(",") || "none"}` : ` observed=${stage.method}:${stage.path} status=${stage.status}`}`,
    );
  }
  reported = nodes.report().stages.length;
}

test("destination OTP and independent browser OAuth retain access after the move", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const identity = {
    did: run.source.did,
    email: destinationEmail,
    handle: run.destinationHandle,
  };
  const endpoint = run.prepared.destinationEndpoint;
  const did = identity.did;
  const writes = [];
  const tokenGrant = (grantType) => (candidate) =>
    candidate.url() === new URL("/oauth/token", config.issuer).href &&
    candidate.request().method() === "POST" &&
    new URLSearchParams(candidate.request().postData() ?? "").get(
      "grant_type",
    ) === grantType &&
    candidate.ok();
  // On two nodes: the email-code session and the authorization-code exchange
  // on the first node, the refresh of that same grant on the second.
  await nodes.stage(
    "email-code session",
    0,
    did,
    () =>
      test.step("destination email OTP returns the source DID", () =>
        sdk.signInAccount(page, identity)),
    { page },
  );
  const { grant, originalAuthorization } = await nodes.stage(
    "authorization",
    0,
    did,
    async () => {
      const [exchange] = await Promise.all([
        page.waitForResponse(tokenGrant("authorization_code"), {
          timeout: 60_000,
        }),
        test.step("destination handle prompts for consent and #issuer names Entryway", () =>
          sdk.authorizeBrowserApp(page, identity)),
      ]);
      nodes.expectServed(exchange, "authorization-code exchange");
      const grant = await exchange.json();
      expect(grant.sub).toBe(did);
      expect(
        typeof grant.refresh_token === "string" &&
          grant.refresh_token.length > 0,
        "the code exchange issued a refresh token",
      ).toBe(true);
      const original =
        await test.step("DPoP write is read back at the SDK audience on the prepared destination", () =>
          expectSdkWrite(page, sdk, {
            ...identity,
            endpoint,
            text: `Migrated ${unique}`,
          }));
      await page.reload();
      await expect(page.locator("#verified-did")).toHaveText(identity.did);
      writes.push(original.uri);
      return { grant, originalAuthorization: original.authorization };
    },
    { page },
  );
  await nodes.stage(
    "grant refresh",
    1,
    did,
    () =>
      test.step("successful token refresh followed by a refreshed-session write", async () => {
        const refreshed = await expectSdkAction(page, {
          issuer: config.issuer,
          path: "/oauth/token",
          button: "Refresh authorization",
          grantType: "refresh_token",
        });
        nodes.expectServed(refreshed, "refresh-token grant");
        // The same grant: the refresh presents the code exchange's refresh
        // token, at the same issuer, for the same subject.
        expect(
          new URLSearchParams(refreshed.request().postData()).get(
            "refresh_token",
          ) === grant.refresh_token,
          "refresh presents the code exchange's refresh token",
        ).toBe(true);
        expect((await refreshed.json()).sub).toBe(did);
        await expect(page.getByRole("status")).toHaveText(
          "Authorization refreshed",
        );
        await expect(page.locator("#issuer")).toHaveText(config.issuer);
        const refreshedWrite = await expectSdkWrite(page, sdk, {
          ...identity,
          endpoint,
          text: `Refreshed ${unique}`,
        });
        expect(
          refreshedWrite.authorization !== originalAuthorization,
          "write used a different access token",
        ).toBe(true);
        writes.push(refreshedWrite.uri);
      }),
    { page },
  );
  await test.step("the transferred inventory is still served beside the client's writes", async () => {
    expect(writes.length).toBe(2);
    await expectInventoryRetained(endpoint, {
      did,
      inventory: run.inventory,
      writes,
    });
  });
  await nodes.stage(
    "revocation",
    0,
    did,
    () => revokeBrowserSession(page, identity),
    { page },
  );
  // Its authorization starts on the client's origin and redirects into the
  // issuer, which a route does not follow: pinned by extra headers instead.
  await nodes.stage(
    "confidential client",
    1,
    did,
    () => authorizeConfidentialClient(page, identity, endpoint),
    { page, via: "headers" },
  );
  if (nodes.enabled) {
    const [session, authorization] = [
      "email-code session",
      "authorization",
    ].map((name) => nodes.stages.find(({ stage }) => stage === name));
    expect(
      authorization.instanceId,
      "session and code exchange on one node",
    ).toBe(session.instanceId);
    nodes.expectAlternation(
      ["authorization", "grant refresh", "revocation", "confidential client"],
      did,
    );
    reportNodes();
  }
});

async function revokeBrowserSession(page, identity) {
  await test.step("revocation removes the browser SDK client's server session", async () => {
    const account = await page.context().newPage();
    await account.goto(`${config.issuer}/account`);
    const sessions = account.locator("#sessions");
    const sdkSession = sessions
      .locator("li")
      .filter({
        has: account.getByText(`${sdk.browserUrl}/oauth-client-metadata.json`, {
          exact: true,
        }),
      })
      .filter({
        has: account.getByRole("button", {
          name: "Revoke OAuth session",
          exact: true,
        }),
      });
    await expect(sdkSession).toHaveCount(1);
    await expectSdkAction(page, {
      issuer: config.issuer,
      path: "/oauth/revoke",
      button: "Revoke this client session",
    });
    await expect(page.getByLabel("Handle", { exact: true })).toBeVisible();

    await account.reload();
    await expect(account.getByTestId("account-did")).toHaveText(identity.did);
    await expect(sessions).toContainText("No active OAuth refresh sessions.");
    await expect(sdkSession).toHaveCount(0);
    await account.close();
  });
}

async function authorizeConfidentialClient(page, identity, endpoint) {
  await test.step("the separate confidential client authorizes and writes as the migrated DID", async () => {
    await confidential.beginAuthorization(page, {
      identifier: identity.handle,
      prompt: "consent",
    });
    await confidential.finishConsent(page, identity.did);
    const pds = config.pds.find(({ url }) => url === endpoint);
    expect(Boolean(pds), "prepared host in service config").toBe(true);
    await confidential.assertOAuthSubjectAndWrite(
      page,
      { ...identity, pdsId: pds.id },
      { text: `Confidential ${unique}` },
    );
  });
}

// Source and destination sessions are independent cutover observations. Keep
// the source refusal last so it cannot mask the destination access results.
test("the old source refreshes as deactivated and refuses both access tokens for writes", async () => {
  await expectSourceCutover(access.sourceUrl, run.source);
});
