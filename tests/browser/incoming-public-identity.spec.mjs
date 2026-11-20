import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createSourceAccount,
  prepareArrival,
} from "../support/helpers/incoming-journey.mjs";
import {
  arrivalStates,
  arrivalSummary,
  changeSourceHandle,
  creationMethod,
  destinationRepoStatus,
  freshIncomingCode,
  handoffMethod,
  incomingCall,
  incomingPost,
  inviteFields,
  plcAudit,
  plcData,
  plcHead,
  refusal,
  restoreSourceRotationKeys,
  serviceAuth,
  signHandoff,
  wellKnownDid,
} from "../support/helpers/incoming-failures.mjs";

// Public incoming cases where the DID's PLC head moves at the source while an
// arrival is in progress, run with the other failure cases by
// `./tests/local.sh incoming-public-failures` (phase `cases`). The source
// change is an ordinary user request to the stock source, `updateHandle`,
// which the stock PDS signs with its own rotation key and publishes on top of
// the current head. Entryway is reached only through its public pages and
// XRPC routes. Each refusal asserts its status and error name, that Entryway
// added nothing to the DID's PLC audit log, and what the owner's /incoming
// status page shows. No response body of a refused call is printed.
let access;
let config;
const id = () => randomUUID().replaceAll("-", "").slice(0, 16);

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  access = JSON.parse(readFileSync(process.env.INCOMING_ACCESS_PATH, "utf8"));
  assert.equal(access.project, process.env.INCOMING_PROJECT);
  config = JSON.parse(readFileSync(process.env.SERVICE_CONFIG_PATH, "utf8"));
});

/** A fresh empty source account and its prepared arrival, in the owner's own
 * browser. The rotation list before any handoff is kept for the cleanup. */
async function preparedMove(page, label) {
  const tag = id();
  const sourceEmail = `${label}-source-${tag}@example.com`;
  const email = `${label}-arrival-${tag}@example.com`;
  const { source } = await createSourceAccount(access, {
    unique: tag,
    email: sourceEmail,
    password: `Identity-${randomUUID()}!`,
    shape: "empty",
  });
  const sourceKeys = (await plcData(access, source.did)).rotationKeys;
  const handle = `d${tag}${config.handleDomains[0]}`;
  const prepared = await prepareArrival(page, {
    issuer: config.issuer,
    mailpitUrl: access.mailpitUrl,
    did: source.did,
    handle,
    email,
  });
  return { tag, source, sourceEmail, email, handle, prepared, sourceKeys };
}

/** Nothing published, created or claimed beyond `saved`: the PLC audit log is
 * exactly `audit`, the destination hosts no repository for the DID, the
 * destination handle does not resolve and the saved arrival reads `saved`. */
async function expectHeld(page, move, { audit, saved }, what) {
  expect(
    isDeepStrictEqual(await plcAudit(access, move.source.did), audit),
    `${what}: PLC audit log unchanged`,
  ).toBe(true);
  expect(
    await destinationRepoStatus(
      move.prepared.destinationEndpoint,
      move.source.did,
    ),
    `${what}: no destination repository`,
  ).toEqual({ status: 400, error: "RepoNotFound" });
  expect(
    (await wellKnownDid(move.handle)).status,
    `${what}: destination handle unresolved`,
  ).toBe(404);
  expect(
    await arrivalSummary(page, config, move.prepared.operationId),
    `${what}: saved arrival`,
  ).toEqual(saved);
}

test("a foreign PLC head between handoff and creation holds creation for recovery and Entryway publishes nothing over it", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const move = await preparedMove(page, "foreign");
  const { source, prepared } = move;
  const handoff = await signHandoff(access, {
    source,
    sourceEmail: move.sourceEmail,
    handoff: prepared.handoff,
  });
  await test.step("the handoff is admitted and published", async () => {
    const admitted = await incomingCall(config, handoffMethod, {
      jwt: await serviceAuth(access, config, source, handoffMethod),
      code: prepared.arrivalCode,
      body: { operation: handoff },
    });
    expect(admitted.status).toBe(200);
    expect(
      isDeepStrictEqual(await plcHead(access, source.did), handoff),
      "exact signed PLC handoff",
    ).toBe(true);
    expect(
      (await arrivalSummary(page, config, prepared.operationId)).state,
    ).toBe(arrivalStates.handoffPublished);
  });
  let foreign;
  await test.step("a handle change at the source moves the head past the handoff; Entryway's rotation key stays", async () => {
    await changeSourceHandle(access, source, `t${move.tag}`);
    foreign = await plcHead(access, source.did);
    expect(isDeepStrictEqual(foreign, handoff), "head moved").toBe(false);
    // The foreign operation keeps the handoff's rotation list, so Entryway
    // still holds a key that could sign over it.
    expect(foreign.rotationKeys).toEqual(handoff.rotationKeys);
    expect(foreign.rotationKeys).toEqual(prepared.handoff.rotationKeys);
  });
  const held = {
    audit: await plcAudit(access, source.did),
    saved: await arrivalSummary(page, config, prepared.operationId),
  };
  expect(held.saved.state).toBe(arrivalStates.handoffPublished);
  expect(held.saved.unresolved).toBe(false);
  const request = {
    jwt: await serviceAuth(access, config, source, creationMethod),
    code: prepared.arrivalCode,
    body: { handle: move.handle, ...(await inviteFields(config)) },
  };
  await test.step("createAccount is refused with 409 OperationRecoveryRequired; nothing is published or created", async () => {
    expect(
      refusal(await incomingCall(config, creationMethod, request)),
    ).toEqual({ status: 409, error: "OperationRecoveryRequired" });
    // The creation admission is saved (the version advances), so the exact
    // request is the documented retry; the state is still handoff-published.
    const saved = await arrivalSummary(page, config, prepared.operationId);
    expect(saved.version).toBeGreaterThan(held.saved.version);
    held.saved = saved;
    await expectHeld(page, move, held, "creation over a foreign head");
  });
  await test.step("the exact replay and the owner's resume stay held with 409 OperationRecoveryRequired", async () => {
    expect(
      refusal(await incomingCall(config, creationMethod, request)),
    ).toEqual({ status: 409, error: "OperationRecoveryRequired" });
    await expectHeld(page, move, held, "exact replay");
    const resumed = await incomingPost(page, config, "/incoming/resume", {
      operationId: prepared.operationId,
    });
    expect(refusal(resumed)).toEqual({
      status: 409,
      error: "OperationRecoveryRequired",
    });
    await expectHeld(page, move, held, "resume");
  });
  await test.step("the user removes Entryway's rotation key through the source; creation stays held", async () => {
    // The documented way out of an abandoned handoff, which also leaves this
    // sandbox DID without Entryway authority.
    const restored = await restoreSourceRotationKeys(access, {
      source,
      sourceEmail: move.sourceEmail,
      rotationKeys: move.sourceKeys,
    });
    expect(
      isDeepStrictEqual(await plcHead(access, source.did), restored),
      "source restoration is the head",
    ).toBe(true);
    expect((await plcData(access, source.did)).rotationKeys).toEqual(
      move.sourceKeys,
    );
    held.audit = await plcAudit(access, source.did);
    expect(
      refusal(await incomingCall(config, creationMethod, request)),
    ).toEqual({ status: 409, error: "OperationRecoveryRequired" });
    await expectHeld(page, move, held, "after restoration");
  });
});

// Known defect: a superseded handoff claims the arrival. Its predecessor is the
// one saved at preparation, so it passes validation although the source head
// has moved since. `admit` (src/features/external-migration/submit-handoff.ts)
// then commits the claim, the replay binding and the signed handoff, and the
// head-divergence check runs only inside the handoff dispatch's `send`, after
// the claim has committed and the dispatch marker is written. The open receipt
// cannot be released by operator recovery either: an approved retry observes
// the head as diverged and refuses again. Ordinary tests pin what happens
// today, so any change fails them; the intended outcome is asserted separately
// under test.fail, so an unexpected pass fails the run once it is fixed.
const supersededDefect =
  "known defect: a superseded handoff is claimed before its head check (submit-handoff.ts checks head divergence inside the dispatch's send, after the claim commits and the dispatch marker is written)";
const unresolvedDefect =
  "known defect: the /incoming status page shows no unresolved-request notice for the superseded handoff's open dispatch receipt, although migration pages are documented to explain the operator dependency (docs/shared-operations.md)";

// The arrival the observed-today test leaves claimed, and the owner's page,
// whose context is kept open for the status-page test that follows it.
let locked;

test.afterAll(async () => {
  await locked?.page.context().close();
});

/** A prepared move whose handoff was signed on the prepared head and then
 * superseded by a handle change at the source. */
async function supersededMove(page, label) {
  const move = await preparedMove(page, label);
  const { source, prepared } = move;
  const stale = await signHandoff(access, {
    source,
    sourceEmail: move.sourceEmail,
    handoff: prepared.handoff,
  });
  await changeSourceHandle(access, source, `t${move.tag}`);
  const head = await plcHead(access, source.did);
  expect(isDeepStrictEqual(head, stale), "head is the source change").toBe(
    false,
  );
  const held = {
    audit: await plcAudit(access, source.did),
    saved: await arrivalSummary(page, config, prepared.operationId),
  };
  expect(held.saved.state).toBe(arrivalStates.prepared);
  expect(held.saved.unresolved).toBe(false);
  const submit = async (operation) =>
    incomingCall(config, handoffMethod, {
      jwt: await serviceAuth(access, config, source, handoffMethod),
      code: prepared.arrivalCode,
      body: { operation },
    });
  return { move, stale, held, submit };
}

test("observed today: a superseded signed handoff is refused but claims the arrival, which then holds the DID", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const page = await (await browser.newContext()).newPage();
  locked = { page };
  const { move, stale, held, submit } = await supersededMove(page, "stale");
  const { source, prepared } = move;
  await test.step("a handoff signed on the new head gets 400 InvalidPlcOperation and nothing is claimed", async () => {
    const rebased = await signHandoff(access, {
      source,
      sourceEmail: move.sourceEmail,
      handoff: prepared.handoff,
    });
    expect(refusal(await submit(rebased))).toEqual({
      status: 400,
      error: "InvalidPlcOperation",
    });
    await expectHeld(page, move, held, "rebased handoff");
  });
  await test.step("observed today: the superseded handoff gets 409 OperationRecoveryRequired; it is not published but the arrival is claimed", async () => {
    expect(refusal(await submit(stale))).toEqual({
      status: 409,
      error: "OperationRecoveryRequired",
    });
    // The claim, replay binding and signed handoff committed before the head
    // check, so the saved version advances while the state stays prepared.
    const saved = await arrivalSummary(page, config, prepared.operationId);
    expect(saved.state).toBe(arrivalStates.prepared);
    expect(saved.version).toBeGreaterThan(held.saved.version);
    // Observed today: no unresolved-request notice for the open dispatch
    // receipt. The documented notice is asserted under test.fail below.
    expect(saved.unresolved).toBe(false);
    held.saved = saved;
    await expectHeld(page, move, held, "superseded handoff");
  });
  await test.step("observed today: its exact replay and a creation get 409 OperationRecoveryRequired", async () => {
    expect(refusal(await submit(stale))).toEqual({
      status: 409,
      error: "OperationRecoveryRequired",
    });
    await expectHeld(page, move, held, "superseded handoff replay");
    const created = await incomingCall(config, creationMethod, {
      jwt: await serviceAuth(access, config, source, creationMethod),
      code: prepared.arrivalCode,
      body: { handle: move.handle, ...(await inviteFields(config)) },
    });
    expect(refusal(created)).toEqual({
      status: 409,
      error: "OperationRecoveryRequired",
    });
    const saved = await arrivalSummary(page, config, prepared.operationId);
    // The creation admission is saved under the claim before the head check.
    expect(saved.state).toBe(arrivalStates.prepared);
    expect(saved.version).toBeGreaterThan(held.saved.version);
    held.saved = saved;
    await expectHeld(page, move, held, "creation after a superseded handoff");
  });
  await test.step("observed today: the claim holds the DID; cancel and a new preparation are refused", async () => {
    const cancelled = await incomingPost(page, config, "/incoming/cancel", {
      operationId: prepared.operationId,
      expectedVersion: held.saved.version,
      otp: await freshIncomingCode(page, config, move.email),
    });
    expect(refusal(cancelled)).toEqual({
      status: 409,
      error: "OperationRecoveryRequired",
    });
    const again = await incomingPost(page, config, "/incoming/prepare", {
      did: source.did,
      handle: `e${move.tag}${config.handleDomains[0]}`,
      otp: await freshIncomingCode(page, config, move.email),
    });
    expect(refusal(again)).toEqual({ status: 409, error: "OperationPending" });
    await expectHeld(page, move, held, "cancel and new preparation");
  });
  locked.move = move;
});

test("the status page explains the operator dependency of the superseded handoff's open request", async () => {
  test.fail(true, unresolvedDefect);
  const saved = await arrivalSummary(
    locked.page,
    config,
    locked.move.prepared.operationId,
  );
  expect(saved.unresolved).toBe(true);
});

test("a superseded signed handoff is refused without a claim, so the user can prepare again", async ({
  page,
}) => {
  test.fail(true, supersededDefect);
  test.setTimeout(240_000);
  const { move, stale, held, submit } = await supersededMove(
    page,
    "superseded",
  );
  // Which error names the refusal is not decided; the intended outcome is
  // that nothing is published or claimed.
  expect((await submit(stale)).status, "superseded handoff refused").not.toBe(
    200,
  );
  // Today this fails: the version has advanced.
  await expectHeld(page, move, held, "superseded handoff");
  const again = await incomingPost(page, config, "/incoming/prepare", {
    did: move.source.did,
    handle: `e${move.tag}${config.handleDomains[0]}`,
    otp: await freshIncomingCode(page, config, move.email),
  });
  expect(again.status, "new preparation").toBe(200);
});
