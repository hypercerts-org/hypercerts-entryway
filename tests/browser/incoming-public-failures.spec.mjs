import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  call,
  createSourceAccount,
  errorName,
  expectDestinationServes,
  json,
  prepareArrival,
} from "../support/helpers/incoming-journey.mjs";
import {
  arrivalStates,
  arrivalSummary,
  creationMethod,
  freshIncomingCode,
  handoffMethod,
  incomingCall,
  browserPost,
  destinationRepoStatus,
  incomingPost,
  inviteFields,
  jwtClaims,
  plcData,
  plcHead,
  refreshAtEntryway,
  refusal,
  serviceAuth,
  sessionProbe,
  signHandoff,
  signInByEmail,
  signUpOrdinary,
  expectOrdinaryAccountUnchanged,
  transferAndActivate,
  wellKnownDid,
} from "../support/helpers/incoming-failures.mjs";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";

// Public incoming-migration failure cases that need no service restart, run
// only by `./tests/local.sh incoming-public-failures` (phase `cases`). Like the
// public journey, Entryway is reached only through its public pages and XRPC
// routes, the source is the standalone stock PDS and mail comes from Mailpit.
// Every refusal asserts its documented status and error name, and that nothing
// was published (PLC head unchanged) or claimed (the saved arrival's state and
// version unchanged). No response body of a refused call is printed.
let access;
let config;
let sdk;
let owner;
const id = () => randomUUID().replaceAll("-", "").slice(0, 16);
const unique = id();
const destinationEmail = `failure-arrival-${unique}@example.com`;
const sourceEmail = `failure-source-${unique}@example.com`;
const run = {};
// Fixed wording of the pending-arrival page (src/accounts/pending-arrival.ts).
const pendingText = "This account is part of an unfinished incoming migration.";

test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ browser }) => {
  sdk = await import("../support/helpers/browser-oauth.mjs");
  access = JSON.parse(readFileSync(process.env.INCOMING_ACCESS_PATH, "utf8"));
  assert.equal(access.project, process.env.INCOMING_PROJECT);
  config = JSON.parse(readFileSync(process.env.SERVICE_CONFIG_PATH, "utf8"));
  // The destination owner's own browser, kept for the whole migration so its
  // verified session can read status, ask for codes and recover credentials.
  owner = await (await browser.newContext()).newPage();
});
test.afterAll(async () => {
  await owner?.context().close();
});

test("the standalone sources serve their seeded inventories", async () => {
  const created = await createSourceAccount(access, {
    unique,
    email: sourceEmail,
    password: `Failure-${randomUUID()}!`,
    shape: "blob-bearing",
    displayName: "Incoming failure cases",
  });
  run.source = created.source;
  run.inventory = created.inventory;
  run.destinationHandle = `d${unique}${config.handleDomains[0]}`;
  // A second, unrelated account on the same source, for a foreign proof.
  const other = id();
  run.other = (
    await createSourceAccount(access, {
      unique: other,
      email: `failure-other-${other}@example.com`,
      password: `Other-${randomUUID()}!`,
      shape: "empty",
    })
  ).source;
  expect(run.other.did).not.toBe(run.source.did);
});

test("the browser verifies the destination email and prepares the arrival", async () => {
  run.prepared = await prepareArrival(owner, {
    issuer: config.issuer,
    access,
    mailpitUrl: access.mailpitUrl,
    did: run.source.did,
    handle: run.destinationHandle,
    email: destinationEmail,
  });
  const exported = await call(access.sourceUrl, "com.atproto.sync.getRepo", {
    params: { did: run.source.did },
  });
  expect(exported.status, "source export status").toBe(200);
  run.car = exported.content;
});

test("expired and foreign source proofs are refused before admission, then a fresh proof is admitted", async () => {
  const did = run.source.did;
  const { operationId, arrivalCode } = run.prepared;
  run.operation = await signHandoff(access, {
    source: run.source,
    sourceEmail,
    handoff: run.prepared.handoff,
  });
  const before = await plcHead(access, did);
  const saved = await arrivalSummary(owner, config, operationId);
  expect(saved.state).toBe(arrivalStates.prepared);
  const submit = (jwt) =>
    incomingCall(config, handoffMethod, {
      jwt,
      code: arrivalCode,
      body: { operation: run.operation },
    });
  const unchanged = async (what) => {
    expect(
      isDeepStrictEqual(await plcHead(access, did), before),
      `${what}: PLC head unchanged`,
    ).toBe(true);
    expect(
      await arrivalSummary(owner, config, operationId),
      `${what}: arrival not claimed`,
    ).toEqual(saved);
  };
  await test.step("a source service JWT that has expired is refused with 403 AccountMismatch", async () => {
    // getServiceAuth accepts any future `exp` up to an hour; ask for two seconds.
    const exp = Math.floor(Date.now() / 1000) + 2;
    const jwt = await serviceAuth(access, config, run.source, handoffMethod, {
      exp,
    });
    const claims = jwtClaims(jwt);
    expect(claims.aud, "audience is this Entryway").toBe(config.serviceDid);
    expect(
      claims.exp === exp &&
        claims.iss === did &&
        claims.lxm === handoffMethod &&
        claims.exp - claims.iat <= 5,
      "short-lived source JWT for this method",
    ).toBe(true);
    while (Date.now() / 1000 <= exp + 1) await delay(250);
    expect(refusal(await submit(jwt))).toEqual({
      status: 403,
      error: "AccountMismatch",
    });
    await unchanged("expired proof");
  });
  await test.step("another account's source service JWT is refused with 409 ArrivalExpired", async () => {
    const jwt = await serviceAuth(access, config, run.other, handoffMethod);
    expect(jwtClaims(jwt).iss === run.other.did, "foreign issuer").toBe(true);
    expect(refusal(await submit(jwt))).toEqual({
      status: 409,
      error: "ArrivalExpired",
    });
    await unchanged("foreign proof");
  });
  await test.step("a fresh source service JWT is admitted and only the signed handoff is published", async () => {
    const admitted = await submit(
      await serviceAuth(access, config, run.source, handoffMethod),
    );
    expect({
      status: admitted.status,
      cacheControl: admitted.cacheControl,
    }).toEqual({ status: 200, cacheControl: "no-store" });
    expect(
      isDeepStrictEqual(await plcHead(access, did), run.operation),
      "exact signed PLC handoff",
    ).toBe(true);
    expect((await arrivalSummary(owner, config, operationId)).state).toBe(
      arrivalStates.handoffPublished,
    );
  });
});

test("creation without a recovery key issues tracked credentials, and an exact replay after the response is lost conflicts", async () => {
  const request = {
    jwt: await serviceAuth(access, config, run.source, creationMethod),
    code: run.prepared.arrivalCode,
    body: {
      handle: run.destinationHandle,
      ...(await inviteFields(config)),
    },
  };
  const created = await incomingCall(config, creationMethod, request);
  expect({
    status: created.status,
    cacheControl: created.cacheControl,
  }).toEqual({ status: 200, cacheControl: "no-store" });
  expect(created.body.did).toBe(run.source.did);
  expect(created.body.handle).toBe(run.destinationHandle);
  expect(created.body.active).toBe(false);
  // The client loses this response. The test keeps the credentials only to
  // show below that recovery revokes them.
  run.discarded = {
    accessJwt: created.body.accessJwt,
    refreshJwt: created.body.refreshJwt,
  };
  expect(refusal(await incomingCall(config, creationMethod, request))).toEqual({
    status: 409,
    error: "OperationConflict",
  });
});

test("the pending account's console shows only the pending page and refuses its actions", async () => {
  // The owner's verified session from preparation now resolves to the bound,
  // still-provisioning account.
  const settings = await owner.goto(`${config.issuer}/account`);
  expect(settings.status()).toBe(409);
  await expect(owner.locator("h1")).toHaveText("Migration in progress");
  await expect(owner.getByText(pendingText)).toBeVisible();
  await expect(
    owner.getByRole("heading", { name: "Account settings" }),
  ).toHaveCount(0);
  for (const [action, fields] of [
    ["status", { status: "deactivated" }],
    ["handle", { handle: `x${unique}${config.handleDomains[0]}` }],
  ]) {
    const answer = await browserPost(
      owner,
      config,
      `/account/${action}`,
      { did: run.source.did, ...fields },
      { form: true },
    );
    expect(
      {
        status: answer.status,
        title: answer.title,
        pending: answer.text.includes(pendingText),
      },
      `console ${action}`,
    ).toEqual({ status: 409, title: "Migration in progress", pending: true });
  }
  expect(
    (await arrivalSummary(owner, config, run.prepared.operationId)).state,
  ).toBe(arrivalStates.pausedPending);
});

// Documented (docs/incoming-migration.md, "Pending guard"): browser email
// sign-in still succeeds for a pending arrival, creates a session and shows the
// pending page. Observed on this tree: /auth/verify answers 404 "Unable to
// continue" ("Account not found") and commits no session, for `/login` and for
// the OAuth sign-in alike. Cause: assertLoginEmail
// (src/features/account-settings/security.mjs) calls
// syncBoundAccountEmailVerification, whose account() lookup
// (src/database/drizzle/account-authority.mjs) refuses `provisioning` accounts.
// Ordinary tests pin what is observed, so any change fails them; the documented
// behaviour is asserted separately under test.fail, so an unexpected pass fails
// the run once the defect is fixed.
const knownDefect =
  "known defect: pending-account email sign-in answers 404 AccountNotFound (security.mjs assertLoginEmail, syncBoundAccountEmailVerification, account-authority.mjs account() refuses provisioning)";
const noSession = { status: 303, location: "/login" };

test("observed today: email-code sign-in of a pending account answers 404 Unable to continue and creates no session", async ({
  page,
}) => {
  // Positive control for the session probe: the owner's verified session.
  expect(await sessionProbe(owner, config)).toEqual({
    status: 200,
    location: null,
  });
  const shown = await signInByEmail(page, config, destinationEmail);
  expect(shown.status).toBe(404);
  await expect(shown.heading).toHaveText("Unable to continue");
  await expect(
    page.getByText("Account not found", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(pendingText)).toHaveCount(0);
  expect(await sessionProbe(page, config)).toEqual(noSession);
});

test("email-code sign-in of a pending account succeeds and shows the pending notice", async ({
  page,
}) => {
  const shown = await signInByEmail(page, config, destinationEmail);
  if (shown.status === 404) {
    await expect(
      page.getByText("Account not found", { exact: true }),
    ).toBeVisible();
    expect(await sessionProbe(page, config)).toEqual(noSession);
  } else {
    expect(shown.status).toBe(200);
    await expect(page.getByText(pendingText)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create account" }),
    ).toHaveCount(0);
    // A session exists: the owner's status page opens.
    expect(
      (await arrivalSummary(page, config, run.prepared.operationId)).state,
    ).toBe(arrivalStates.pausedPending);
  }
  test.fail(true, knownDefect);
  expect(shown.status === 200, "pending account sign-in accepted").toBe(true);
});

/** The browser SDK client authorizes by DID through Entryway's email-code
 * step. Returns the status of Entryway's answer to the code. */
async function authorizeByDid(client) {
  await client.goto(sdk.browserUrl);
  await expect(
    client.getByRole("heading", { name: "Entryway browser client" }),
  ).toBeVisible();
  await client.getByLabel("Handle", { exact: true }).fill(run.source.did);
  const since = Date.now();
  await client.getByRole("button", { name: "Continue" }).click();
  const signIn = client.getByRole("heading", {
    name: "Sign in to authorize",
  });
  const codeStep = client.getByRole("heading", { name: "Check your email" });
  await expect(signIn.or(codeStep)).toBeVisible();
  if (await signIn.isVisible()) {
    await client.getByLabel("Email address").fill(destinationEmail);
    await client.getByRole("button", { name: "Send sign-in code" }).click();
    await expect(codeStep).toBeVisible();
  }
  const { code } = await waitForMailpitCode({
    recipient: destinationEmail,
    since,
  });
  await sdk.enterSignInCode(client, code);
  const [verified] = await Promise.all([
    client.waitForResponse(
      (response) =>
        response.url().endsWith("/auth/verify") &&
        response.request().method() === "POST",
    ),
    client.getByRole("button", { name: "Verify code" }).click(),
  ]);
  expect(new URL(client.url()).origin).toBe(new URL(config.issuer).origin);
  return verified.status();
}

const noConsent = async (client) => {
  await expect(client.locator('form[action="/auth/consent"]')).toHaveCount(0);
  await expect(
    client.getByRole("button", { name: "Allow access" }),
  ).toHaveCount(0);
};

test("observed today: OAuth authorization of the pending account cannot start by handle and by DID answers 404 Unable to continue after the code", async ({
  page: client,
}) => {
  await test.step("the destination handle does not resolve while the account is pending", async () => {
    // Entryway's handle endpoint answers 404 for a provisioning account
    // (src/app.mjs, /.well-known/atproto-did), so a client cannot start. The
    // activation test below is its positive control.
    expect(await wellKnownDid(run.destinationHandle)).toEqual({
      status: 404,
      did: null,
    });
    await client.goto(sdk.browserUrl);
    await client
      .getByLabel("Handle", { exact: true })
      .fill(run.destinationHandle);
    await client.getByRole("button", { name: "Continue" }).click();
    await expect(client.locator("#login-form-error")).not.toBeEmpty();
    expect(new URL(client.url()).origin).toBe(sdk.browserUrl);
  });
  await test.step("by DID, the code gets 404 Unable to continue, no consent and no session", async () => {
    // The consent guard (src/features/oauth-authorization/consent.mjs) is not
    // reached: sign-in fails first.
    expect(await authorizeByDid(client)).toBe(404);
    await expect(client.locator("h1")).toHaveText("Unable to continue");
    await expect(
      client.getByText("Account not found", { exact: true }),
    ).toBeVisible();
    await noConsent(client);
    expect(await sessionProbe(client, config)).toEqual(noSession);
  });
});

test("OAuth sign-in of the pending account succeeds and is refused consent with the pending notice", async ({
  page: client,
}) => {
  // Accepted sign-in: the signup page's pending notice (200) or the consent
  // guard's page (409). Today this first assertion fails, with 404.
  const status = await authorizeByDid(client);
  if (status === 404) {
    await expect(
      client.getByText("Account not found", { exact: true }),
    ).toBeVisible();
    await noConsent(client);
    expect(await sessionProbe(client, config)).toEqual(noSession);
  } else {
    expect([200, 409], "sign-in accepted").toContain(status);
    await expect(client.getByText(pendingText)).toBeVisible();
    await noConsent(client);
    expect((await sessionProbe(client, config)).status).toBe(200);
  }
  test.fail(true, knownDefect);
  expect(status !== 404, "pending account sign-in accepted").toBe(true);
});

test("recovery with a fresh code replaces the lost credentials and revokes the earlier family", async () => {
  const endpoint = run.prepared.destinationEndpoint;
  const saved = await arrivalSummary(owner, config, run.prepared.operationId);
  expect(saved.state).toBe(arrivalStates.pausedPending);
  const otp = await freshIncomingCode(owner, config, destinationEmail);
  const recovered = await incomingPost(owner, config, "/incoming/recover", {
    operationId: run.prepared.operationId,
    expectedVersion: saved.version,
    otp,
  });
  expect({
    status: recovered.status,
    cacheControl: recovered.cacheControl,
  }).toEqual({ status: 200, cacheControl: "no-store" });
  expect(recovered.body.did).toBe(run.source.did);
  expect(
    recovered.body.accessJwt !== run.discarded.accessJwt &&
      recovered.body.refreshJwt !== run.discarded.refreshJwt,
    "replacement credentials differ",
  ).toBe(true);
  await test.step("documented limit: the stock destination accepts the earlier access token until it expires", async () => {
    const { exp } = jwtClaims(run.discarded.accessJwt);
    // Only meaningful while that token is still within its five-minute life.
    expect(exp - Date.now() / 1000 > 10, "earlier access token unexpired").toBe(
      true,
    );
    const status = await call(
      endpoint,
      "com.atproto.server.checkAccountStatus",
      {
        token: run.discarded.accessJwt,
      },
    );
    expect(status.status).toBe(200);
    expect(json(status).activated).toBe(false);
  });
  await test.step("Entryway refuses the earlier refresh and access tokens with 400 ExpiredToken", async () => {
    expect(
      refusal(await refreshAtEntryway(config, run.discarded.refreshJwt)),
    ).toEqual({ status: 400, error: "ExpiredToken" });
    const stale = await call(
      config.issuer,
      "com.atproto.server.activateAccount",
      { token: run.discarded.accessJwt },
    );
    expect({ status: stale.status, error: errorName(stale) }).toEqual({
      status: 400,
      error: "ExpiredToken",
    });
  });
  await test.step("the replacement refresh token rotates at Entryway", async () => {
    const rotated = await refreshAtEntryway(config, recovered.body.refreshJwt);
    expect(rotated.status).toBe(200);
    expect(rotated.body.did).toBe(run.source.did);
    run.destination = rotated.body;
  });
});

test("the replacement credentials complete the move, and without a recovery key the rotation list is the approved one", async () => {
  await transferAndActivate({
    endpoint: run.prepared.destinationEndpoint,
    token: run.destination.accessJwt,
    car: run.car,
    blobs: run.inventory.blobs,
  });
  await expectDestinationServes(access, {
    endpoint: run.prepared.destinationEndpoint,
    did: run.source.did,
    inventory: run.inventory,
    handle: run.destinationHandle,
  });
  // Positive control for the pending account's 404 at the handle endpoint.
  expect(await wellKnownDid(run.destinationHandle)).toEqual({
    status: 200,
    did: run.source.did,
  });
  // The no-recovery-key control for the public journey's key-ordering check.
  expect((await plcData(access, run.source.did)).rotationKeys).toEqual(
    run.prepared.handoff.rotationKeys,
  );
});

async function expectHandoffConflict({
  page,
  source,
  prepared,
  operation,
  before,
  saved,
  error,
}) {
  const refused = await incomingCall(config, handoffMethod, {
    jwt: await serviceAuth(access, config, source, handoffMethod),
    code: prepared.arrivalCode,
    body: { operation },
  });
  expect(refusal(refused)).toEqual({
    status: 409,
    error,
  });
  expect(
    isDeepStrictEqual(await plcHead(access, source.did), before),
    "source PLC head unchanged",
  ).toBe(true);
  expect(
    await arrivalSummary(page, config, prepared.operationId),
    "arrival not claimed",
  ).toEqual(saved);
}

test("an arrival whose destination email an account took after preparation is refused and the account is unchanged", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const tag = id();
  const email = `failure-claimed-${tag}@example.com`;
  const sourceAddress = `failure-claimed-source-${tag}@example.com`;
  const domain = config.handleDomains[0];
  const context = await browser.newContext();
  let settings;
  try {
    const page = await context.newPage();
    const { source } = await createSourceAccount(access, {
      unique: tag,
      email: sourceAddress,
      password: `Claimed-${randomUUID()}!`,
      shape: "empty",
    });
    const prepared = await prepareArrival(page, {
      issuer: config.issuer,
      access,
      mailpitUrl: access.mailpitUrl,
      did: source.did,
      handle: `d${tag}${domain}`,
      email,
    });
    // A second browser of the same verified owner, which then holds the account.
    settings = await context.browser().newContext();
    const signup = await settings.newPage();
    let existing;
    await test.step("the same verified owner signs up an ordinary account with that email", async () => {
      await signup.waitForTimeout(6_000);
      existing = await signUpOrdinary(signup, {
        config,
        access,
        email,
        handle: `e${tag}${domain}`,
      });
    });
    // The target-conflict case below reuses this hosted account.
    run.hosted = { ...existing, email };
    const operation = await signHandoff(access, {
      source,
      sourceEmail: sourceAddress,
      handoff: prepared.handoff,
    });
    const before = await plcHead(access, source.did);
    const saved = await arrivalSummary(page, config, prepared.operationId);
    expect(saved.state).toBe(arrivalStates.prepared);
    await test.step("the signed handoff is refused with 409 EmailNotAvailable and nothing is published or claimed", async () => {
      await expectHandoffConflict({
        page,
        source,
        prepared,
        operation,
        before,
        saved,
        error: "EmailNotAvailable",
      });
    });
    await test.step("a new preparation for that email is refused with 409 EmailNotAvailable", async () => {
      const otp = await freshIncomingCode(page, config, email);
      const again = await incomingPost(page, config, "/incoming/prepare", {
        did: source.did,
        handle: `f${tag}${domain}`,
        otp,
      });
      expect(refusal(again)).toEqual({
        status: 409,
        error: "EmailNotAvailable",
      });
      expect(
        await arrivalSummary(page, config, prepared.operationId),
        "earlier arrival unchanged",
      ).toEqual(saved);
    });
    await test.step("the existing account keeps its DID, handle, email and identity", async () => {
      await expectOrdinaryAccountUnchanged(signup, {
        config,
        access,
        account: existing,
        email,
      });
    });
  } finally {
    await settings?.close();
    await context.close();
  }
});

test("a destination handle or DID already hosted at the target is refused and the hosted accounts are unchanged", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const tag = id();
  const email = `failure-target-${tag}@example.com`;
  const sourceAddress = `failure-target-source-${tag}@example.com`;
  const domain = config.handleDomains[0];
  // Two accounts the target already hosts: the ordinary account from the case
  // above, and the DID this file migrated in and activated.
  const hosted = run.hosted;
  const migrated = { did: run.source.did, handle: run.destinationHandle };
  const identity = async (account) => ({
    head: await plcHead(access, account.did),
    resolved: await wellKnownDid(account.handle),
  });
  const hostedBefore = await identity(hosted);
  const migratedBefore = await identity(migrated);
  expect(hostedBefore.resolved).toEqual({ status: 200, did: hosted.did });
  expect(migratedBefore.resolved).toEqual({ status: 200, did: migrated.did });
  const context = await browser.newContext();
  let taker;
  try {
    const page = await context.newPage();
    const { source } = await createSourceAccount(access, {
      unique: tag,
      email: sourceAddress,
      password: `Target-${randomUUID()}!`,
      shape: "empty",
    });
    const handle = `d${tag}${domain}`;
    const prepared = await prepareArrival(page, {
      issuer: config.issuer,
      access,
      mailpitUrl: access.mailpitUrl,
      did: source.did,
      handle,
      email,
    });
    const before = await plcHead(access, source.did);
    const saved = await arrivalSummary(page, config, prepared.operationId);
    expect(saved.state).toBe(arrivalStates.prepared);
    // A refused preparation keeps the user's earlier unclaimed one.
    const refusedPreparation = async (fields, expected) => {
      const otp = await freshIncomingCode(page, config, email);
      const answer = await incomingPost(page, config, "/incoming/prepare", {
        ...fields,
        otp,
      });
      expect(refusal(answer)).toEqual(expected);
      expect(
        await arrivalSummary(page, config, prepared.operationId),
        "earlier arrival unchanged",
      ).toEqual(saved);
    };
    await test.step("a preparation with a handle the target hosts is refused with 409 HandleNotAvailable", async () => {
      await refusedPreparation(
        { did: source.did, handle: hosted.handle },
        { status: 409, error: "HandleNotAvailable" },
      );
    });
    await test.step("a preparation for the DID of an ordinary hosted account is refused with 409 IdentityConflict", async () => {
      await refusedPreparation(
        { did: hosted.did, handle: `g${tag}${domain}` },
        { status: 409, error: "IdentityConflict" },
      );
    });
    await test.step("a preparation for a DID already migrated in is refused with 409 IdentityConflict", async () => {
      await refusedPreparation(
        { did: migrated.did, handle: `h${tag}${domain}` },
        { status: 409, error: "IdentityConflict" },
      );
    });
    const operation = await signHandoff(access, {
      source,
      sourceEmail: sourceAddress,
      handoff: prepared.handoff,
    });
    await test.step("an ordinary account takes the prepared handle", async () => {
      taker = await browser.newContext();
      const signup = await taker.newPage();
      run.taker = await signUpOrdinary(signup, {
        config,
        access,
        email: `failure-taker-${tag}@example.com`,
        handle,
      });
    });
    await test.step("the signed handoff is then refused with 409 HandleNotAvailable and nothing is published or claimed", async () => {
      await expectHandoffConflict({
        page,
        source,
        prepared,
        operation,
        before,
        saved,
        error: "HandleNotAvailable",
      });
    });
    await test.step("the hosted accounts keep their identity", async () => {
      for (const [account, earlier] of [
        [hosted, hostedBefore],
        [migrated, migratedBefore],
      ])
        expect(
          isDeepStrictEqual(await identity(account), earlier),
          `${account === hosted ? "ordinary" : "migrated"} account unchanged`,
        ).toBe(true);
      expect(
        await destinationRepoStatus(
          run.prepared.destinationEndpoint,
          migrated.did,
        ),
      ).toEqual({ status: 200, error: null });
      await expectOrdinaryAccountUnchanged(taker.pages()[0], {
        config,
        access,
        account: run.taker,
        email: `failure-taker-${tag}@example.com`,
      });
    });
  } finally {
    await taker?.close();
    await context.close();
  }
});
