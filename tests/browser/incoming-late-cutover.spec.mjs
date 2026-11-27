import { test, expect } from "@playwright/test";
import { Secp256k1Keypair } from "@atproto/crypto";
import { cidForCbor } from "@atproto/common";
import { readCarWithRoot } from "@atproto/repo";
import { randomUUID } from "node:crypto";
import { access as fileAccess, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  call,
  createSourceAccount,
  errorName,
  expectDestinationServes,
  json,
} from "../support/helpers/incoming-journey.mjs";
import {
  arrivalStates,
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
import { submitWithoutClientResponse } from "../support/helpers/incoming-lost-response.mjs";

const afterPublished = process.env.INCOMING_AFTER_SIGNED_PUBLICATION === "1";
const cutoverCase = afterPublished
  ? "staged signed publication survives a lost client response and restart"
  : "a public incoming migration keeps the source DID until the staged repository is ready";

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

test(cutoverCase, async ({ page }) => {
  const direct = test.info().project.metadata.submitAt === "destination";
  test.skip(
    afterPublished && direct,
    "The lost response is at Entryway's signed handoff endpoint",
  );
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
      await xrpc(access.sourceUrl, "sync.getLatestCommit", {
        params: { did },
      }),
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
  await arrivalSummary(page, config, prepared.operationId);
  const rotationKeys = await page
    .getByText("Approved rotation keys, in priority order", { exact: true })
    .locator("+ ol li code")
    .allTextContents();
  expect(rotationKeys).toEqual([recoveryKey, ...prepared.approvedRotationKeys]);
  const sourceIdentity = historyBeforeMove.at(-1).operation;
  const primaryHandle = sourceIdentity.alsoKnownAs.findIndex((alias) =>
    alias.startsWith("at://"),
  );
  const identityFields = {
    ...recommended,
    alsoKnownAs: [
      `at://${handle}`,
      ...sourceIdentity.alsoKnownAs.filter(
        (_, index) => index !== primaryHandle,
      ),
    ],
    verificationMethods: {
      ...sourceIdentity.verificationMethods,
      atproto: recommended.verificationMethods.atproto,
    },
    services: { ...sourceIdentity.services, ...recommended.services },
  };
  if (!direct) {
    expect(recommended.rotationKeys).not.toEqual(rotationKeys);
    const narrower = await signAtSource(access, {
      source,
      sourceEmail,
      fields: identityFields,
    });
    expect(narrower.rotationKeys).toEqual(recommended.rotationKeys);
    expect(narrower.prev).toBe(predecessor);
    const rejected = await admitted(handoffMethod, { operation: narrower });
    expect(rejected.status).toBe(400);
    expect(rejected.error).toBe("InvalidPlcOperation");
    expect(await plcAudit(access, did)).toEqual(historyBeforeMove);
  }
  const operation = await signAtSource(access, {
    source,
    sourceEmail,
    fields: { ...identityFields, rotationKeys },
  });
  expect(operation.prev).toBe(predecessor);
  expect(await plcAudit(access, did)).toEqual(historyBeforeMove);
  expect((await sourceHead()).cid).toBe(last.cid);
  const signedCid = String(await cidForCbor(operation));
  if (process.env.INCOMING_BEFORE_SIGNED_SUBMIT === "1") {
    expect(afterPublished).toBe(false);
    expect(direct).toBe(false);
    const beforeRestart = await arrivalSummary(
      page,
      config,
      prepared.operationId,
    );
    const sourceBeforeRestart = await plcData(access, did);
    await writeFile("/run/incoming-barrier/ready", "ready\n");
    let released = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        await fileAccess("/run/incoming-barrier/release");
        released = true;
        break;
      } catch {
        await delay(1000);
      }
    }
    expect(released, "Entryway restart barrier released").toBe(true);
    expect(await arrivalSummary(page, config, prepared.operationId)).toEqual(
      beforeRestart,
    );
    expect(await plcAudit(access, did)).toEqual(historyBeforeMove);
    expect(await plcData(access, did)).toEqual(sourceBeforeRestart);
    expect(sourceBeforeRestart.services.atproto_pds.endpoint).toBe(
      access.sourceUrl,
    );
    expect((await sourceHead()).cid).toBe(last.cid);
    expect(operation.prev).toBe(predecessor);
    expect(String(await cidForCbor(operation))).toBe(signedCid);
    expect(
      await page
        .getByText("Approved rotation keys, in priority order", {
          exact: true,
        })
        .locator("+ ol li code")
        .allTextContents(),
    ).toEqual(rotationKeys);
  }
  if (direct) {
    await xrpc(endpoint, "identity.submitPlcOperation", {
      token,
      body: { operation },
    });
  } else if (afterPublished) {
    const lost = await submitWithoutClientResponse(config, {
      jwt: await serviceAuth(access, config, source, handoffMethod),
      code: prepared.arrivalCode,
      body: { operation },
    });
    expect(lost.upstreamStatus, "Entryway completed the public handoff").toBe(
      200,
    );
    expect(lost.clientFailed, "migration client received no success").toBe(
      true,
    );
    const publishedAudit = await plcAudit(access, did);
    expect(publishedAudit.slice(0, -1)).toEqual(historyBeforeMove);
    expect(publishedAudit.at(-1)).toMatchObject({
      cid: signedCid,
      operation,
    });
    const publishedData = await plcData(access, did);
    expect(publishedData.services.atproto_pds.endpoint).toBe(endpoint);
    expect(publishedData.rotationKeys).toEqual(rotationKeys);
    const saved = await arrivalSummary(page, config, prepared.operationId);
    expect(saved.did).toBe(did);
    expect(saved.state).toBe(arrivalStates.pausedPending);
    await expect(
      page.getByText("Entryway checks for missing referenced blobs.", {
        exact: false,
      }),
    ).toBeVisible();
    expect(
      await page
        .getByText("Approved rotation keys, in priority order", {
          exact: true,
        })
        .locator("+ ol li code")
        .allTextContents(),
    ).toEqual(rotationKeys);
    expect((await status()).activated).toBe(false);
    await writeFile("/run/incoming-after-publication/ready", "ready\n");
    let released = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        await fileAccess("/run/incoming-after-publication/release");
        released = true;
        break;
      } catch {
        await delay(1000);
      }
    }
    expect(released, "after-publication restart barrier released").toBe(true);
    expect(await arrivalSummary(page, config, prepared.operationId)).toEqual(
      saved,
    );
    await expect(
      page.getByText("Entryway checks for missing referenced blobs.", {
        exact: false,
      }),
    ).toBeVisible();
    expect(
      await page
        .getByText("Approved rotation keys, in priority order", {
          exact: true,
        })
        .locator("+ ol li code")
        .allTextContents(),
    ).toEqual(rotationKeys);
    expect(await plcAudit(access, did)).toEqual(publishedAudit);
    expect(await plcData(access, did)).toEqual(publishedData);
    expect((await status()).activated).toBe(false);
    const afterRestartCredentials = json(
      await xrpc(endpoint, "identity.getRecommendedDidCredentials", {
        token,
      }),
    );
    expect(afterRestartCredentials.services.atproto_pds.endpoint).toBe(
      endpoint,
    );
    const retried = await admitted(handoffMethod, { operation });
    expect(retried.status, retried.error ?? "retry submitPlcOperation").toBe(
      200,
    );
    expect(await plcAudit(access, did)).toEqual(publishedAudit);
  } else {
    const submitted = await admitted(handoffMethod, { operation });
    expect(submitted.status, submitted.error ?? "submitPlcOperation").toBe(200);
  }
  const audit = await plcAudit(access, did);
  expect(audit.slice(0, -1)).toEqual(historyBeforeMove);
  expect(audit.at(-1).operation).toEqual(operation);
  expect(audit.at(-1).cid).toBe(signedCid);
  const moved = await plcData(access, did);
  expect(moved.rotationKeys).toEqual(rotationKeys);
  expect(moved.verificationMethods.atproto).toBe(
    recommended.verificationMethods.atproto,
  );
  await xrpc(endpoint, "server.activateAccount", { token });
  // Retry the same request as if the first success response had been lost.
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
        record: {
          ...record,
          text: "Written after sign-in at the destination",
        },
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
  test.skip(
    afterPublished || test.info().project.metadata.submitAt !== "entryway",
  );
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
