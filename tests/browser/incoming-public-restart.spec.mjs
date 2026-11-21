import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Secp256k1Keypair } from "@atproto/crypto";
import {
  call,
  createSourceAccount,
  expectDestinationServes,
  ok,
  prepareArrival,
} from "../support/helpers/incoming-journey.mjs";
import {
  arrivalStates,
  arrivalSummary,
  creationMethod,
  freshIncomingCode,
  handoffMethod,
  incomingCall,
  incomingPost,
  inviteFields,
  jwtClaims,
  plcData,
  plcHead,
  refreshAtEntryway,
  refusal,
  serviceAuth,
  signHandoff,
  signInByEmail,
  transferAndActivate,
} from "../support/helpers/incoming-failures.mjs";

// A restart of Entryway between two admitted steps of a public incoming move,
// run only by `./tests/local.sh incoming-public-failures`. Specs run inside the
// browser container and cannot restart services, so the controller runs this
// file twice: phase `before-restart` stops after the handoff is admitted and
// published, the controller restarts the Entryway service, waits for it and
// checks that its container start time changed, then phase `after-restart`
// continues. This is a restart between admitted
// steps, not an interruption during provisioning.
//
// Cross-phase state (source session, arrival code, signed operation) lives in
// one private file the controller mounts from outside the artifact directory
// and deletes unconditionally. It is never printed.
const phase = process.env.INCOMING_FAILURES_PHASE;
const statePath = process.env.INCOMING_FAILURES_STATE;
let access;
let config;
let owner;

test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ browser }) => {
  access = JSON.parse(readFileSync(process.env.INCOMING_ACCESS_PATH, "utf8"));
  assert.equal(access.project, process.env.INCOMING_PROJECT);
  config = JSON.parse(readFileSync(process.env.SERVICE_CONFIG_PATH, "utf8"));
  assert.ok(statePath?.startsWith("/run/"), "private restart state path");
  owner = await (await browser.newContext()).newPage();
});
test.afterAll(async () => {
  await owner?.context().close();
});

if (phase === "before-restart") {
  const unique = randomUUID().replaceAll("-", "").slice(0, 16);
  const run = {
    sourceEmail: `restart-source-${unique}@example.com`,
    destinationEmail: `restart-arrival-${unique}@example.com`,
  };

  test("before the restart: the standalone source serves the seeded inventory", async () => {
    const created = await createSourceAccount(access, {
      unique,
      email: run.sourceEmail,
      password: `Restart-${randomUUID()}!`,
      shape: "blob-bearing",
      displayName: "Incoming restart case",
    });
    run.source = created.source;
    run.inventory = created.inventory;
    run.destinationHandle = `d${unique}${config.handleDomains[0]}`;
  });

  test("before the restart: the browser verifies the destination email and prepares the arrival", async () => {
    run.prepared = await prepareArrival(owner, {
      issuer: config.issuer,
      mailpitUrl: access.mailpitUrl,
      did: run.source.did,
      handle: run.destinationHandle,
      email: run.destinationEmail,
    });
  });

  test("before the restart: the handoff is admitted and published, then the state is saved privately", async () => {
    run.operation = await signHandoff(access, {
      source: run.source,
      sourceEmail: run.sourceEmail,
      handoff: run.prepared.handoff,
    });
    // Short-lived on purpose: it has expired when phase two replays it.
    const exp = Math.floor(Date.now() / 1000) + 20;
    run.handoffJwt = await serviceAuth(
      access,
      config,
      run.source,
      handoffMethod,
      { exp },
    );
    const submitted = await incomingCall(config, handoffMethod, {
      jwt: run.handoffJwt,
      code: run.prepared.arrivalCode,
      body: { operation: run.operation },
    });
    expect({
      status: submitted.status,
      cacheControl: submitted.cacheControl,
    }).toEqual({ status: 200, cacheControl: "no-store" });
    expect(
      isDeepStrictEqual(await plcHead(access, run.source.did), run.operation),
      "exact signed PLC handoff",
    ).toBe(true);
    expect(
      (await arrivalSummary(owner, config, run.prepared.operationId)).state,
    ).toBe(arrivalStates.handoffPublished);
    writeFileSync(
      statePath,
      JSON.stringify({
        ...run,
        inventory: {
          records: run.inventory.records,
          blobs: run.inventory.blobs.map(({ cid, bytes }) => ({
            cid,
            bytes: bytes.toString("base64"),
          })),
        },
      }),
      { mode: 0o600, flag: "wx" },
    );
  });
}

if (phase === "after-restart") {
  let run;
  let renewedCode;

  test("after the restart: a fresh code renews the arrival code of the admitted arrival", async () => {
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    run = {
      ...saved,
      inventory: {
        records: saved.inventory.records,
        blobs: saved.inventory.blobs.map(({ cid, bytes }) => ({
          cid,
          bytes: Buffer.from(bytes, "base64"),
        })),
      },
    };
    // A new browser session: phase one's browser ended with its run.
    await signInByEmail(owner, config, run.destinationEmail);
    const summary = await arrivalSummary(
      owner,
      config,
      run.prepared.operationId,
    );
    expect(summary.did).toBe(run.source.did);
    expect(summary.state).toBe(arrivalStates.handoffPublished);
    const otp = await freshIncomingCode(owner, config, run.destinationEmail);
    const renewed = await incomingPost(owner, config, "/incoming/renew", {
      operationId: run.prepared.operationId,
      expectedVersion: summary.version,
      otp,
    });
    expect({
      status: renewed.status,
      cacheControl: renewed.cacheControl,
    }).toEqual({ status: 200, cacheControl: "no-store" });
    expect(renewed.body.operationId).toBe(run.prepared.operationId);
    renewedCode = renewed.body.arrivalCode;
    expect(
      /^[A-Za-z0-9_-]{32}$/.test(renewedCode) &&
        renewedCode !== run.prepared.arrivalCode,
      "a new arrival code",
    ).toBe(true);
  });

  test("after the restart: the exact handoff replay with the renewed code resumes without re-verifying its expired proof", async () => {
    const replay = (code) =>
      incomingCall(config, handoffMethod, {
        jwt: run.handoffJwt,
        code,
        body: { operation: run.operation },
      });
    // Renewal superseded the code phase one used.
    expect(refusal(await replay(run.prepared.arrivalCode))).toEqual({
      status: 409,
      error: "ArrivalExpired",
    });
    const { exp } = jwtClaims(run.handoffJwt);
    while (Date.now() / 1000 <= exp + 1) await delay(250);
    const resumed = await replay(renewedCode);
    expect({
      status: resumed.status,
      cacheControl: resumed.cacheControl,
    }).toEqual({ status: 200, cacheControl: "no-store" });
    expect(isDeepStrictEqual(resumed.body, {}), "empty replay response").toBe(
      true,
    );
    // Still the one handoff: the replay published nothing new.
    expect(
      isDeepStrictEqual(await plcHead(access, run.source.did), run.operation),
      "PLC head is still the handoff",
    ).toBe(true);
  });

  test("after the restart: the first createAccount is a new admission with a fresh method-bound JWT", async () => {
    run.recoveryKey = (await Secp256k1Keypair.create()).did();
    const body = {
      handle: run.destinationHandle,
      password: `Arrive-${randomUUID()}-${randomUUID()}`,
      recoveryKey: run.recoveryKey,
      ...(await inviteFields(config)),
    };
    const create = async (jwt) =>
      incomingCall(config, creationMethod, { jwt, code: renewedCode, body });
    await test.step("the same body with a JWT bound to another method is refused with 403 AccountMismatch, so no creation was admitted", async () => {
      // An exact replay of a recorded admission needs no source credential
      // (it would answer 200), so verification refusing this body shows that
      // phase one saved no creation admission.
      const saved = await arrivalSummary(
        owner,
        config,
        run.prepared.operationId,
      );
      expect(saved.state).toBe(arrivalStates.handoffPublished);
      const wrongMethod = await serviceAuth(
        access,
        config,
        run.source,
        handoffMethod,
      );
      expect(jwtClaims(wrongMethod).lxm).toBe(handoffMethod);
      expect(refusal(await create(wrongMethod))).toEqual({
        status: 403,
        error: "AccountMismatch",
      });
      expect(
        isDeepStrictEqual(await plcHead(access, run.source.did), run.operation),
        "PLC head is still the handoff",
      ).toBe(true);
      expect(
        await arrivalSummary(owner, config, run.prepared.operationId),
        "arrival not advanced",
      ).toEqual(saved);
    });
    const created = await create(
      await serviceAuth(access, config, run.source, creationMethod),
    );
    expect({
      status: created.status,
      cacheControl: created.cacheControl,
    }).toEqual({ status: 200, cacheControl: "no-store" });
    expect(created.body.did).toBe(run.source.did);
    expect(created.body.handle).toBe(run.destinationHandle);
    expect(created.body.active).toBe(false);
    run.destination = created.body;
  });

  test("after the restart: the move completes and the destination serves the transferred state", async () => {
    const exported = await call(access.sourceUrl, "com.atproto.sync.getRepo", {
      params: { did: run.source.did },
    });
    expect(exported.status, "source export status").toBe(200);
    const refreshed = await refreshAtEntryway(
      config,
      run.destination.refreshJwt,
    );
    expect(refreshed.status).toBe(200);
    await transferAndActivate({
      endpoint: run.prepared.destinationEndpoint,
      token: refreshed.body.accessJwt,
      car: exported.content,
      blobs: run.inventory.blobs,
    });
    await expectDestinationServes(access, {
      endpoint: run.prepared.destinationEndpoint,
      did: run.source.did,
      inventory: run.inventory,
      handle: run.destinationHandle,
    });
    const data = await plcData(access, run.source.did);
    expect(data.rotationKeys[0]).toBe(run.recoveryKey);
    expect(data.rotationKeys.slice(1)).toEqual(
      run.prepared.handoff.rotationKeys,
    );
    ok(
      await call(access.sourceUrl, "com.atproto.server.deactivateAccount", {
        token: run.source.accessJwt,
        body: {},
      }),
      "source deactivation",
    );
  });
}
