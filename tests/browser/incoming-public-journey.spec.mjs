import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  call,
  createSourceAccount,
  expectDestinationServes,
  json,
  ok,
  prepareArrival,
} from "../support/helpers/incoming-journey.mjs";
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
test.beforeAll(() => {
  access = JSON.parse(readFileSync(process.env.INCOMING_ACCESS_PATH, "utf8"));
  assert.equal(access.project, process.env.INCOMING_PROJECT);
  config = JSON.parse(readFileSync(process.env.SERVICE_CONFIG_PATH, "utf8"));
});

test("a standalone source account has a record and a blob", async () => {
  const created = await createSourceAccount(access, {
    unique,
    email: sourceEmail,
    password: `Public-${randomUUID()}!`,
    displayName: "Public arrival journey",
  });
  run.source = created.source;
  run.blob = created.blob;
  run.sourceHandle = created.handle;
  run.destinationHandle = `d${unique}${config.handleDomains[0]}`;
  expect(run.sourceHandle).not.toBe(run.destinationHandle);
});

test("the browser verifies the destination email and prepares the arrival", async ({
  page,
}) => {
  run.prepared = await prepareArrival(page, {
    issuer: config.issuer,
    mailpitUrl: access.mailpitUrl,
    did: run.source.did,
    handle: run.destinationHandle,
    email: destinationEmail,
  });
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

test("the client transfers its chosen state directly between the pinned endpoints", async () => {
  const exported = await call(access.sourceUrl, "com.atproto.sync.getRepo", {
    params: { did: run.source.did },
  });
  ok(exported, "source export");
  const imported = await call(
    run.prepared.destinationEndpoint,
    "com.atproto.repo.importRepo",
    {
      token: run.destination.accessJwt,
      bytes: exported.content,
      type: "application/vnd.ipld.car",
    },
  );
  ok(imported, "destination import");
  const blobs = json(
    await call(access.sourceUrl, "com.atproto.sync.listBlobs", {
      params: { did: run.source.did },
    }),
  ).cids;
  for (const cid of blobs) {
    const blob = await call(access.sourceUrl, "com.atproto.sync.getBlob", {
      params: { did: run.source.did, cid },
    });
    ok(blob, "source blob download");
    ok(
      await call(
        run.prepared.destinationEndpoint,
        "com.atproto.repo.uploadBlob",
        {
          token: run.destination.accessJwt,
          bytes: blob.content,
          type: blob.headers.get("content-type") ?? "application/octet-stream",
        },
      ),
      "destination blob upload",
    );
  }
  const status = json(
    await call(
      run.prepared.destinationEndpoint,
      "com.atproto.server.checkAccountStatus",
      { token: run.destination.accessJwt },
    ),
  );
  expect(status.activated).toBe(false);
  expect(status.repoCommit).toBeTruthy();
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
    blob: run.blob,
    displayName: "Public arrival journey",
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
