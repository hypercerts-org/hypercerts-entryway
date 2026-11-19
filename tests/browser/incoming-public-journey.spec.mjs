import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  call,
  errorName,
  expectDestinationServes,
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

// Public incoming-migration journey, run only by `./tests/local.sh
// incoming-public-journey` inside an owned sandbox. Entryway is reached only
// through its public browser pages and XRPC routes. The source is the standalone
// stock PDS, the destination is a stock PDS behind Entryway, mail is read from
// Mailpit, and nothing seeds authority rows or calls a private fixture. The
// client chooses what to transfer and when to activate; this does not certify
// completeness of every record or blob.
// Read in beforeAll so test discovery works without a sandbox.
let access;
let config;
let sdk;
let confidential;
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
});

registerArrivalSetup(test, {
  context: () => ({ access, config }),
  run,
  unique,
  sourceEmail,
  sourcePassword: `Public-${randomUUID()}!`,
  destinationEmail,
  displayName: "Public arrival journey",
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
  // Wrong code, then wrong method, are refused before anything is published.
  const wrongCode = await fetch(
    new URL(`/xrpc/${handoffMethod}`, config.issuer),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await serviceAuth(handoffMethod)}`,
        "entryway-arrival-code": "A".repeat(32),
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation }),
    },
  );
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
      },
      body: JSON.stringify({ operation }),
    },
  );
  expect(wrongMethod.status).toBe(403);
  const submitted = await fetch(
    new URL(`/xrpc/${handoffMethod}`, config.issuer),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await serviceAuth(handoffMethod)}`,
        "entryway-arrival-code": run.prepared.arrivalCode,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation }),
    },
  );
  expect(submitted.status).toBe(200);
  expect(submitted.headers.get("cache-control")).toBe("no-store");
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
  const headers = {
    authorization: `Bearer ${await serviceAuth(creationMethod)}`,
    "entryway-arrival-code": run.prepared.arrivalCode,
    "content-type": "application/json",
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
  expect(repeated.status).toBe(409);
  expect((await repeated.json()).error).toBe("OperationConflict");
  // The paused destination refuses ordinary activation paths at Entryway.
  const plain = await fetch(
    new URL("/xrpc/com.atproto.server.getSession", config.issuer),
    { headers: { authorization: `Bearer ${run.destination.accessJwt}` } },
  );
  expect(plain.status).toBeGreaterThanOrEqual(400);
});

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
  const cars = await malformedCars(run.car, run.inventory.records.at(-1));
  // The final block of this export is a seeded record, not a tree node.
  expect(
    run.inventory.records.some(({ cid }) => cid === cars.droppedBlock),
    "dropped final block is a record",
  ).toBe(true);
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
      "a CAR missing its final block is refused",
      cars.cutAtBlock,
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
  const refreshed = await fetch(
    new URL("/xrpc/com.atproto.server.refreshSession", config.issuer),
    {
      method: "POST",
      headers: { authorization: `Bearer ${run.destination.refreshJwt}` },
    },
  );
  expect(refreshed.status).toBe(200);
  run.destination = await refreshed.json();
  const activated = await call(
    run.prepared.destinationEndpoint,
    "com.atproto.server.activateAccount",
    { token: run.destination.accessJwt },
  );
  ok(activated, "stock activateAccount");
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
  for (const identifier of [run.destinationHandle, run.source.did]) {
    const session = await call(
      config.issuer,
      "com.atproto.server.createSession",
      {
        body: { identifier, password: destinationPassword },
      },
    );
    expect(session.status, "password createSession status").toBe(200);
    expect(json(session).did).toBe(run.source.did);
  }
  ok(
    await call(access.sourceUrl, "com.atproto.server.deactivateAccount", {
      token: run.source.accessJwt,
      body: {},
    }),
    "source deactivation",
  );
});

test("the tracked destination family refreshes as an active account session", async () => {
  const response = await fetch(
    new URL("/xrpc/com.atproto.server.refreshSession", config.issuer),
    {
      method: "POST",
      headers: { authorization: `Bearer ${run.destination.refreshJwt}` },
    },
  );
  expect(response.status).toBe(200);
  expect((await response.json()).did).toBe(run.source.did);
});

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
  await test.step("destination email OTP returns the source DID", () =>
    sdk.signInAccount(page, identity));
  await test.step("destination handle prompts for consent and #issuer names Entryway", () =>
    sdk.authorizeBrowserApp(page, identity));
  const originalAuthorization =
    await test.step("DPoP write is read back at the SDK audience on the prepared destination", () =>
      expectSdkWrite(page, sdk, {
        ...identity,
        endpoint,
        text: `Migrated ${unique}`,
      }));
  await page.reload();
  await expect(page.locator("#verified-did")).toHaveText(identity.did);
  await test.step("successful token refresh followed by a refreshed-session write", async () => {
    await expectSdkAction(page, {
      issuer: config.issuer,
      path: "/oauth/token",
      button: "Refresh authorization",
      grantType: "refresh_token",
    });
    await expect(page.getByRole("status")).toHaveText(
      "Authorization refreshed",
    );
    const refreshedAuthorization = await expectSdkWrite(page, sdk, {
      ...identity,
      endpoint,
      text: `Refreshed ${unique}`,
    });
    expect(
      refreshedAuthorization !== originalAuthorization,
      "write used a different access token",
    ).toBe(true);
  });
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
});

// Source and destination sessions are independent cutover observations. Keep
// the source refusal last so it cannot mask the destination access results.
test("the old source refreshes as deactivated and refuses both access tokens for writes", async () => {
  await expectSourceCutover(access.sourceUrl, run.source);
});
