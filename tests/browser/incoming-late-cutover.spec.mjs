import { test, expect } from "@playwright/test";
import { Secp256k1Keypair } from "@atproto/crypto";
import { readCarWithRoot } from "@atproto/repo";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  call,
  createSourceAccount,
  errorName,
  expectDestinationServes,
  json,
} from "../support/helpers/incoming-journey.mjs";
import {
  arrivalSummary,
  changeSourceHandle,
  creationMethod,
  freshIncomingCode,
  handoffMethod,
  incomingCall,
  incomingPost,
  inviteFields,
  plcAudit,
  plcData,
  serviceAuth,
  signAtSource,
  signInByEmail,
  signUpOrdinary,
  wellKnownDid,
} from "../support/helpers/incoming-failures.mjs";
import { expectSourceCutover } from "../support/helpers/incoming-post-move.mjs";

async function sandbox() {
  const access = JSON.parse(
    await readFile(process.env.INCOMING_ACCESS_PATH, "utf8"),
  );
  expect(access.project).toBe(process.env.INCOMING_PROJECT);
  const config = JSON.parse(
    await readFile(process.env.SERVICE_CONFIG_PATH, "utf8"),
  );
  return { access, config };
}

async function xrpc(origin, method, options) {
  const response = await call(origin, "com.atproto." + method, options);
  expect(response.status, method + " " + (errorName(response) ?? "")).toBe(200);
  return response;
}

test("a public incoming migration keeps the source DID until the staged repository is ready", async ({
  page,
}) => {
  const direct = test.info().project.metadata.submitAt === "destination";
  const { access, config } = await sandbox();
  const unique = randomUUID().replaceAll("-", "").slice(0, 14);
  const sourceEmail = `source-${unique}@example.com`;
  const email = `destination-${unique}@example.com`;
  const handle = `d${unique}${config.handleDomains[0]}`;
  const password = `Migrate-${randomUUID()}`;
  const { source, inventory } = await createSourceAccount(access, {
    unique,
    email: sourceEmail,
    password: randomUUID(),
    displayName: "Staged migration",
    shape: "blob-bearing",
  });
  const { did } = source;
  const original = await plcData(access, did);
  const history = await plcAudit(access, did);
  expect(original.services.atproto_pds.endpoint).toBe(access.sourceUrl);
  expect(original.rotationKeys).not.toContain(config.plcRotationKeyDid);

  await signInByEmail(page, config, email);
  const otp = await freshIncomingCode(page, config, email);
  const preparation = await incomingPost(page, config, "/incoming/prepare", {
    did,
    handle,
    otp,
    ...(direct ? {} : { retireRotationKeys: original.rotationKeys }),
  });
  expect(preparation.status, preparation.error ?? "prepare").toBe(200);
  const prepared = preparation.body;
  expect(prepared.migrationMode).toBe("staged");
  expect(prepared.handoff).toBeUndefined();
  expect(prepared.approvedRotationKeys).toEqual([
    ...(direct ? original.rotationKeys : []),
    config.plcRotationKeyDid,
  ]);
  const endpoint = prepared.destinationEndpoint;
  expect(endpoint).toBe(access.destinationUrls[0]);
  const recoveryKey = (await Secp256k1Keypair.create()).did();
  const admitted = (method, body) =>
    serviceAuth(access, config, source, method).then((jwt) =>
      incomingCall(config, method, { jwt, code: prepared.arrivalCode, body }),
    );
  const staged = await admitted(creationMethod, {
    did,
    handle,
    password,
    recoveryKey,
    ...(await inviteFields(config)),
  });
  expect(staged.status, staged.error ?? "createAccount").toBe(200);
  expect(staged.body.did).toBe(did);
  expect(staged.body.active).toBe(false);
  const token = staged.body.accessJwt;
  const status = async () =>
    json(await xrpc(endpoint, "server.checkAccountStatus", { token }));
  expect((await status()).activated).toBe(false);
  expect(await plcAudit(access, did)).toEqual(history);

  const sourceHead = async () =>
    json(
      await xrpc(access.sourceUrl, "sync.getLatestCommit", { params: { did } }),
    );
  async function transfer(since) {
    const exported = await xrpc(access.sourceUrl, "sync.getRepo", {
      params: { did, ...(since && { since }) },
    });
    const { root } = await readCarWithRoot(exported.content);
    await xrpc(endpoint, "repo.importRepo", {
      token,
      bytes: exported.content,
      type: "application/vnd.ipld.car",
    });
    return root.toString();
  }
  const initial = await sourceHead();
  expect(await transfer()).toBe(initial.cid);
  const missing = json(
    await xrpc(endpoint, "repo.listMissingBlobs", { token }),
  );
  expect(missing.blobs.map((b) => b.cid)).toEqual(
    inventory.blobs.map((b) => b.cid),
  );
  for (const { cid } of missing.blobs) {
    const blob = await xrpc(access.sourceUrl, "sync.getBlob", {
      params: { did, cid },
    });
    const uploaded = json(
      await xrpc(endpoint, "repo.uploadBlob", {
        token,
        bytes: blob.content,
        type: "image/png",
      }),
    );
    expect(uploaded.blob.ref.$link).toBe(cid);
  }
  const record = {
    $type: "app.bsky.feed.post",
    text: "Written at the source during transfer",
    createdAt: new Date().toISOString(),
  };
  const late = json(
    await xrpc(access.sourceUrl, "repo.createRecord", {
      token: source.accessJwt,
      body: { repo: did, collection: record.$type, record },
    }),
  );
  inventory.records.push({ uri: late.uri, cid: late.cid, value: record });
  inventory.records.sort((a, b) => a.uri.localeCompare(b.uri));
  const last = await sourceHead();
  expect(last.cid).not.toBe(initial.cid);
  expect(await transfer(initial.rev)).toBe(last.cid);
  const ready = await status();
  expect(ready).toMatchObject({
    activated: false,
    repoCommit: last.cid,
    indexedRecords: 2,
    expectedBlobs: 1,
    importedBlobs: 1,
  });
  expect(await plcData(access, did)).toEqual(original);
  expect(await plcAudit(access, did)).toEqual(history);

  let predecessor = prepared.expectedPlcHead;
  let historyBeforeMove = history;
  if (!direct) {
    await changeSourceHandle(access, source, `h${unique}`);
    historyBeforeMove = await plcAudit(access, did);
    expect(historyBeforeMove.slice(0, -1)).toEqual(history);
    const current = await plcData(access, did);
    expect(current.services.atproto_pds.endpoint).toBe(access.sourceUrl);
    expect(current.rotationKeys).toEqual(original.rotationKeys);
    const summary = await arrivalSummary(page, config, prepared.operationId);
    predecessor = historyBeforeMove.at(-1).cid;
    const reviewed = await incomingPost(page, config, "/incoming/reapprove", {
      operationId: prepared.operationId,
      expectedVersion: summary.version,
      expectedPlcHead: predecessor,
      otp: await freshIncomingCode(page, config, email),
    });
    expect(reviewed.status, reviewed.error ?? "reapprove").toBe(200);
    expect(reviewed.body.expectedPlcHead).toBe(predecessor);
    expect(reviewed.body.approvedRotationKeys).toEqual([
      recoveryKey,
      ...prepared.approvedRotationKeys,
    ]);
  }

  const recommended = json(
    await xrpc(endpoint, "identity.getRecommendedDidCredentials", { token }),
  );
  expect(recommended.services.atproto_pds.endpoint).toBe(endpoint);
  const rotationKeys = [recoveryKey, ...prepared.approvedRotationKeys];
  const operation = await signAtSource(access, {
    source,
    sourceEmail,
    fields: { ...recommended, rotationKeys },
  });
  expect(operation.prev).toBe(predecessor);
  expect(await plcAudit(access, did)).toEqual(historyBeforeMove);
  expect((await sourceHead()).cid).toBe(last.cid);
  if (direct) {
    await xrpc(endpoint, "identity.submitPlcOperation", {
      token,
      body: { operation },
    });
  } else {
    const submitted = await admitted(handoffMethod, { operation });
    expect(submitted.status, submitted.error ?? "submitPlcOperation").toBe(200);
  }
  const audit = await plcAudit(access, did);
  expect(audit.slice(0, -1)).toEqual(historyBeforeMove);
  expect(audit.at(-1).operation).toEqual(operation);
  const moved = await plcData(access, did);
  expect(moved.rotationKeys).toEqual(rotationKeys);
  expect(moved.verificationMethods.atproto).toBe(
    recommended.verificationMethods.atproto,
  );
  await xrpc(endpoint, "server.activateAccount", { token });
  expect((await status()).activated).toBe(true);
  await expectDestinationServes(access, { did, endpoint, handle, inventory });
  expect(await wellKnownDid(handle)).toEqual({ status: 200, did });
  const session = json(
    await xrpc(config.issuer, "server.createSession", {
      body: { identifier: handle, password },
    }),
  );
  expect(session.did).toBe(did);
  expect(session.active).not.toBe(false);
  const written = json(
    await xrpc(endpoint, "repo.createRecord", {
      token: session.accessJwt,
      body: {
        repo: did,
        collection: record.$type,
        record: { ...record, text: "Written after sign-in at the destination" },
      },
    }),
  );
  const served = json(
    await xrpc(endpoint, "repo.getRecord", {
      params: {
        repo: did,
        collection: record.$type,
        rkey: written.uri.split("/").at(-1),
      },
    }),
  );
  expect(served.cid).toBe(written.cid);
  await xrpc(access.sourceUrl, "server.deactivateAccount", {
    token: source.accessJwt,
    body: {},
  });
  await expectSourceCutover(access.sourceUrl, source);
});

test("ordinary signup on the staged-capable PDS", async ({ page }) => {
  test.skip(test.info().project.metadata.submitAt !== "entryway");
  const { access, config } = await sandbox();
  const label = `u${randomUUID().slice(0, 8)}`;
  const ordinary = await signUpOrdinary(page, {
    access,
    config,
    email: `${label}@example.com`,
    handle: label + config.handleDomains[0],
  });
  const data = await plcData(access, ordinary.did);
  expect(data.services.atproto_pds.endpoint).toBe(access.destinationUrls[0]);
});
