import { expect } from "@playwright/test";
import { isDeepStrictEqual } from "node:util";
import { call, errorName, json, ok } from "./incoming-journey.mjs";
import { waitForMailpitCode } from "./mailpit.mjs";
import { waitForStockPlcMessage } from "./stock-plc-mailpit.mjs";

// Shared by the incoming failure and restart specs. Nothing here reads the
// sandbox at import time, so `--list` works without one. No helper returns or
// prints a response body of a failed call: only statuses and error names.

export const handoffMethod = "com.atproto.identity.submitPlcOperation";
export const creationMethod = "com.atproto.server.createAccount";

/** A source service JWT for Entryway. `exp` (seconds) asks the stock source
 * for a shorter lifetime than its default minute. */
export async function serviceAuth(access, config, source, lxm, { exp } = {}) {
  const response = await call(
    access.sourceUrl,
    "com.atproto.server.getServiceAuth",
    {
      token: source.accessJwt,
      params: { aud: config.serviceDid, lxm, ...(exp ? { exp } : {}) },
    },
  );
  ok(response, "source getServiceAuth");
  return json(response).token;
}

/** The unverified claims of a JWT this test minted itself. */
export const jwtClaims = (jwt) =>
  JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));

/** Stock PLC confirmation by Mailpit, then the source signs an operation on
 * the DID's current head with the given fields (the others keep their values). */
export async function signAtSource(access, { source, sourceEmail, fields }) {
  const since = Date.now();
  ok(
    await call(
      access.sourceUrl,
      "com.atproto.identity.requestPlcOperationSignature",
      { token: source.accessJwt },
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
      token: source.accessJwt,
      body: { token: confirmation.token, ...fields },
    },
  );
  ok(signed, "source-signed PLC operation");
  return json(signed).operation;
}

/** The source signs the prepared handoff facts. */
export const signHandoff = (access, { source, sourceEmail, handoff }) =>
  signAtSource(access, {
    source,
    sourceEmail,
    fields: {
      rotationKeys: handoff.rotationKeys,
      alsoKnownAs: handoff.alsoKnownAs,
      verificationMethods: handoff.verificationMethods,
      services: handoff.services,
    },
  });

/** A user-requested handle change on the stock source. The stock PDS signs and
 * publishes the PLC update itself with its rotation key, on top of the DID's
 * current head, keeping every other field (including rotation keys). */
export async function changeSourceHandle(access, source, label) {
  const description = json(
    await call(access.sourceUrl, "com.atproto.server.describeServer"),
  );
  const handle = `${label}${description.availableUserDomains[0]}`;
  ok(
    await call(access.sourceUrl, "com.atproto.identity.updateHandle", {
      token: source.accessJwt,
      body: { handle },
    }),
    "source updateHandle",
  );
  return handle;
}

/** The documented way out of an abandoned handoff: the source signs and
 * submits an operation that restores the given rotation list. */
export async function restoreSourceRotationKeys(
  access,
  { source, sourceEmail, rotationKeys },
) {
  const operation = await signAtSource(access, {
    source,
    sourceEmail,
    fields: { rotationKeys },
  });
  ok(
    await call(access.sourceUrl, "com.atproto.identity.submitPlcOperation", {
      token: source.accessJwt,
      body: { operation },
    }),
    "source submitPlcOperation",
  );
  return operation;
}

/** One tool request at Entryway with the arrival header. Returns the status,
 * the error name only, the cache header and (for a success only) the body. */
export async function incomingCall(config, method, { jwt, code, body }) {
  const response = await fetch(new URL(`/xrpc/${method}`, config.issuer), {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "entryway-arrival-code": code,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const content = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    error: errorName({ content }),
    cacheControl: response.headers.get("cache-control"),
    body: response.ok ? json({ content }) : undefined,
  };
}

export const refusal = ({ status, error }) => ({ status, error });

/** The PLC directory's current head operation for a DID. */
export async function plcHead(access, did) {
  const response = await fetch(new URL(`/${did}/log/last`, access.plcUrl));
  expect(response.status, "PLC head status").toBe(200);
  return response.json();
}

/** The DID's whole PLC audit log, so a test can show that nothing was added. */
export async function plcAudit(access, did) {
  const response = await fetch(new URL(`/${did}/log/audit`, access.plcUrl));
  expect(response.status, "PLC audit status").toBe(200);
  return response.json();
}

export async function plcData(access, did) {
  const response = await fetch(new URL(`/${did}/data`, access.plcUrl));
  expect(response.status, "PLC data status").toBe(200);
  return response.json();
}

/** An operator invitation when the deployment requires one. */
export async function inviteFields(config) {
  if (!config.inviteCodeRequired) return {};
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
  expect(invite.status, "invite status").toBe(200);
  return { inviteCode: (await invite.json()).code };
}

/** Email-code sign-in at /login. Returns the heading of the page shown after
 * the code is accepted; the code goes through `evaluate`, never a step title. */
export async function signInByEmail(page, config, email) {
  await page.goto(new URL("/login", config.issuer).href);
  await page.getByLabel("Email address").first().fill(email);
  const since = Date.now();
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  const { code } = await waitForMailpitCode({ recipient: email, since });
  await enterCode(page, "Sign-in code", code);
  const [verified] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/auth/verify") &&
        response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Verify code" }).click(),
  ]);
  return { status: verified.status(), heading: page.locator("h1") };
}

async function enterCode(page, label, code) {
  await page.getByLabel(label).evaluate((input, value) => {
    input.value = value;
  }, code);
}

/** A fresh incoming code to the verified email, sent from the /incoming page.
 * The value is returned to the caller only, never displayed or logged. */
export async function freshIncomingCode(page, config, email) {
  await page.goto(new URL("/incoming", config.issuer).href);
  await expect(
    page.getByRole("heading", { name: "Incoming migration" }),
  ).toBeVisible();
  // Keep the same spacing as preparation between codes to one address.
  await page.waitForTimeout(6_000);
  const since = Date.now();
  await page
    .getByRole("button", { name: "Send me a fresh email code" })
    .click();
  const { code } = await waitForMailpitCode({ recipient: email, since });
  return code;
}

/** This browser's CSRF field, read from the /incoming start page. */
export async function browserCsrf(page, config) {
  await page.goto(new URL("/incoming", config.issuer).href);
  return page.locator('input[name="csrf"]').first().inputValue();
}

/** A POST from this browser's own session: the context's cookies, the issuer
 * Origin a same-origin form would send and the browser's CSRF field. Pages
 * cannot script `fetch` (their CSP is `default-src 'none'`), so it goes
 * through the context's request API. `form` sends a form post, otherwise JSON.
 * Only the status, the error name and, for a success, the body come back. */
export async function browserPost(page, config, path, body, { form } = {}) {
  const csrf = await browserCsrf(page, config);
  const response = await page.request.post(new URL(path, config.issuer).href, {
    headers: { origin: new URL(config.issuer).origin },
    ...(form ? { form: { ...body, csrf } } : { data: { ...body, csrf } }),
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // An HTML page.
  }
  return {
    status: response.status(),
    error: typeof parsed.error === "string" ? parsed.error : null,
    cacheControl: response.headers()["cache-control"] ?? null,
    title: /<h1>([^<]*)<\/h1>/.exec(text)?.[1] ?? null,
    text: form ? text : undefined,
    body: response.ok() && !form ? parsed : undefined,
  };
}

export const incomingPost = (page, config, path, body) =>
  browserPost(page, config, path, body);

/** Whether this browser holds a verified session, without following a
 * redirect: /incoming answers 200 with one and 303 to /login without. */
export async function sessionProbe(page, config) {
  const response = await page.request.get(
    new URL("/incoming", config.issuer).href,
    { maxRedirects: 0, failOnStatusCode: false },
  );
  return {
    status: response.status(),
    location: response.headers().location ?? null,
  };
}

/** A handle's /.well-known/atproto-did answer: the status and, on 200, the DID. */
export async function wellKnownDid(handle) {
  const response = await fetch(`https://${handle}/.well-known/atproto-did`, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  return { status: response.status, did: response.ok ? text.trim() : null };
}

/** The saved user's own arrival as the /incoming status page shows it. */
export async function arrivalSummary(page, config, operationId) {
  const url = new URL("/incoming", config.issuer);
  url.searchParams.set("operationId", operationId);
  const response = await page.goto(url.href);
  expect(response.status(), "arrival status page").toBe(200);
  const fields = await page
    .locator("dl.identity")
    .evaluate((list) =>
      Object.fromEntries(
        [...list.querySelectorAll("dt")].map((term) => [
          term.textContent,
          term.nextElementSibling.textContent,
        ]),
      ),
    );
  return {
    version: Number(fields.Version),
    did: fields.DID,
    state: await page.getByRole("status").first().textContent(),
    // The page's "saved server request is unresolved" notice.
    unresolved: (await page.getByRole("alert").count()) > 0,
  };
}

// The /incoming page's fixed wording for each saved state.
export const arrivalStates = {
  prepared:
    "Prepared. Your migration tool has not completed the identity handoff yet.",
  handoffPublished:
    "Your identity handoff was published. The destination account has not been created yet.",
  pausedPending:
    "The destination account exists and is paused. It is not active: it cannot sign in to applications or be changed here until your migration tool finishes and activation is requested.",
};

/** An ordinary Entryway signup by email code with the given handle, in its
 * own browser. Returns the new account's DID and its PLC head. */
export async function signUpOrdinary(page, { config, access, email, handle }) {
  const shown = await signInByEmail(page, config, email);
  await expect(shown.heading).toHaveText("Create your account");
  await page.getByLabel("Handle", { exact: true }).fill(handle);
  await page.getByLabel("Personal data server").selectOption(config.pds[0].id);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByRole("heading", { name: "Account settings" }),
  ).toBeVisible();
  const did = await page.getByTestId("account-did").textContent();
  expect(did).toMatch(/^did:plc:/);
  return { did, handle, head: await plcHead(access, did) };
}

/** The account console still shows the same DID, handle and verified email,
 * its PLC head is unchanged and Entryway resolves its handle to its DID. */
export async function expectOrdinaryAccountUnchanged(
  page,
  { config, access, account, email },
) {
  const shown = await page.goto(`${config.issuer}/account`);
  expect(shown.status()).toBe(200);
  await expect(page.getByTestId("account-did")).toHaveText(account.did);
  await expect(page.getByTestId("account-handle")).toHaveText(account.handle);
  await expect(page.getByTestId("primary-email")).toHaveText(
    `${email} (verified)`,
  );
  expect(
    isDeepStrictEqual(await plcHead(access, account.did), account.head),
    "existing account PLC head unchanged",
  ).toBe(true);
  const resolved = await call(
    config.issuer,
    "com.atproto.identity.resolveHandle",
    { params: { handle: account.handle } },
  );
  expect(resolved.status).toBe(200);
  expect(json(resolved).did).toBe(account.did);
}

/** The stock destination's repository status for a DID: status and error name
 * only (`RepoNotFound` when it hosts no repository for it). */
export async function destinationRepoStatus(endpoint, did) {
  const response = await call(endpoint, "com.atproto.sync.getRepoStatus", {
    params: { did },
  });
  return { status: response.status, error: errorName(response) };
}

/** Import, upload referenced blobs and activate through the stock destination
 * with the given tracked access token. */
export async function transferAndActivate({ endpoint, token, car, blobs }) {
  ok(
    await call(endpoint, "com.atproto.repo.importRepo", {
      token,
      bytes: car,
      type: "application/vnd.ipld.car",
    }),
    "destination import",
  );
  for (const { bytes } of blobs)
    ok(
      await call(endpoint, "com.atproto.repo.uploadBlob", {
        token,
        bytes,
        type: "image/png",
      }),
      "destination blob upload",
    );
  const status = json(
    await call(endpoint, "com.atproto.server.checkAccountStatus", { token }),
  );
  expect(status.importedBlobs).toBe(status.expectedBlobs);
  expect(status.activated).toBe(false);
  ok(
    await call(endpoint, "com.atproto.server.activateAccount", { token }),
    "stock activateAccount",
  );
  const active = json(
    await call(endpoint, "com.atproto.server.checkAccountStatus", { token }),
  );
  expect(active.activated).toBe(true);
}

/** Rotated tracked credentials, or the refusal. */
export async function refreshAtEntryway(config, refreshJwt) {
  const response = await fetch(
    new URL("/xrpc/com.atproto.server.refreshSession", config.issuer),
    {
      method: "POST",
      headers: { authorization: `Bearer ${refreshJwt}` },
    },
  );
  const content = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    error: errorName({ content }),
    body: response.ok ? json({ content }) : undefined,
  };
}
