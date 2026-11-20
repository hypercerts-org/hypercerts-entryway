import { expect } from "@playwright/test";
import { waitForMailpitCode } from "./mailpit.mjs";

// Shared by the public and goat incoming journeys, which differ only in the
// migration client. The browser step and the XRPC call helper live here so the
// two journeys cannot drift apart.

export async function call(
  origin,
  method,
  { token, body, params, bytes, type } = {},
) {
  const url = new URL(`/xrpc/${method}`, origin);
  for (const [key, value] of Object.entries(params ?? {}))
    url.searchParams.set(key, value);
  const post =
    body !== undefined ||
    bytes !== undefined ||
    /(requestPlcOperationSignature|activateAccount|deactivateAccount)$/.test(
      method,
    );
  const response = await fetch(url, {
    method: post ? "POST" : "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(bytes === undefined ? {} : { "content-type": type }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(bytes === undefined ? {} : { body: bytes }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const content = Buffer.from(await response.arrayBuffer());
  return { status: response.status, content, headers: response.headers };
}

export const json = ({ content }) =>
  JSON.parse(content.toString("utf8") || "{}");

// Status only: bodies of failed calls can echo credentials.
export const ok = (response, what) =>
  expect(response.status, `${what} status`).toBeLessThan(300);

// Verifies the destination email in the browser, asks for a fresh code and
// prepares the arrival. Returns the values the page shows once.
export async function prepareArrival(
  page,
  { issuer, mailpitUrl, did, handle, email },
) {
  const since = Date.now();
  await page.goto(`${issuer}/login`);
  await page.getByLabel("Email address").first().fill(email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  const login = await waitForMailpitCode({
    recipient: email,
    since,
    baseUrl: mailpitUrl,
  });
  await page.getByLabel("Sign-in code").evaluate((input, code) => {
    input.value = code;
  }, login.code);
  await page.getByRole("button", { name: "Verify code" }).click();
  // A verified session exists even though no account does yet.
  await page.goto(`${issuer}/incoming`);
  await expect(
    page.getByRole("heading", { name: "Incoming migration" }),
  ).toBeVisible();
  // The service sends a fresh code to the verified email on request.
  await page.waitForTimeout(6_000);
  const asked = Date.now();
  await page
    .getByRole("button", { name: "Send me a fresh email code" })
    .click();
  const fresh = await waitForMailpitCode({
    recipient: email,
    since: asked,
    excludeIds: [login.messageId],
    baseUrl: mailpitUrl,
  });
  await page.goto(`${issuer}/incoming`);
  await page.getByLabel("Your DID").fill(did);
  await page.getByLabel("Destination handle").fill(handle);
  await page.getByLabel("Fresh email code").evaluate((input, code) => {
    input.value = code;
  }, fresh.code);
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith("/incoming/prepare") &&
      candidate.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Prepare arrival" }).click();
  const prepared = await response;
  expect(prepared.status()).toBe(200);
  expect(prepared.headers()["cache-control"]).toBe("no-store");
  await expect(page.getByText("shown once")).toBeVisible();
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
  const arrival = {
    operationId: fields.operationId,
    version: Number(fields.version),
    arrivalCode: fields.arrivalCode,
    handoff: JSON.parse(fields.handoff),
    destinationEndpoint: fields.destinationEndpoint,
  };
  // Booleans only: a failing assertion must never print the code.
  expect(/^[A-Za-z0-9_-]{32}$/.test(arrival.arrivalCode)).toBe(true);
  expect(arrival.destinationEndpoint).toBeTruthy();
  // No credential or code appears in any URL.
  expect(page.url().includes(arrival.arrivalCode)).toBe(false);
  return arrival;
}

export const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const profile = {
  repo: undefined,
  collection: "app.bsky.actor.profile",
  rkey: "self",
};

// Creates the standalone source account with a profile record that references
// an uploaded avatar blob. Returns the session, the blob reference and the
// source handle. Credentials are passed through and never logged.
export async function createSourceAccount(
  access,
  { unique, email, password, displayName },
) {
  const description = json(
    await call(access.sourceUrl, "com.atproto.server.describeServer"),
  );
  const handle = `s${unique}${description.availableUserDomains[0]}`;
  const created = await call(
    access.sourceUrl,
    "com.atproto.server.createAccount",
    {
      body: { email, password, handle },
    },
  );
  ok(created, "source account");
  const source = json(created);
  const uploaded = await call(access.sourceUrl, "com.atproto.repo.uploadBlob", {
    token: source.accessJwt,
    bytes: pixel,
    type: "image/png",
  });
  ok(uploaded, "source blob");
  const blob = json(uploaded).blob;
  ok(
    await call(access.sourceUrl, "com.atproto.repo.putRecord", {
      token: source.accessJwt,
      body: {
        ...profile,
        repo: source.did,
        record: {
          $type: "app.bsky.actor.profile",
          displayName,
          avatar: blob,
        },
      },
    }),
    "source record",
  );
  return { source, blob, handle };
}

// The destination serves the record and the blob byte for byte, and the PLC
// directory names the destination endpoint and handle.
export async function expectDestinationServes(
  access,
  { endpoint, did, blob, displayName, handle },
) {
  const record = json(
    await call(endpoint, "com.atproto.repo.getRecord", {
      params: { ...profile, repo: did },
    }),
  );
  expect(record.value.displayName).toBe(displayName);
  const served = await call(endpoint, "com.atproto.sync.getBlob", {
    params: { did, cid: blob.ref.$link },
  });
  ok(served, "destination blob");
  expect(served.content.equals(pixel)).toBe(true);
  const document = await (
    await fetch(new URL(`/${did}`, access.plcUrl))
  ).json();
  expect(
    document.service.find((service) => service.id === "#atproto_pds")
      .serviceEndpoint,
  ).toBe(endpoint);
  expect(document.alsoKnownAs).toContain(`at://${handle}`);
}

/**
 * Registers the two opening steps every incoming journey shares: a standalone
 * source account with a record and a blob, then the browser email proof and
 * arrival preparation. `context` returns the sandbox access and service config
 * loaded by the spec's own `beforeAll`; `onPrepared` runs after preparation.
 */
export function registerArrivalSetup(
  test,
  {
    context,
    run,
    unique,
    sourceEmail,
    sourcePassword,
    destinationEmail,
    displayName,
    onPrepared,
  },
) {
  test("a standalone source account has a record and a blob", async () => {
    const { access, config } = context();
    const created = await createSourceAccount(access, {
      unique,
      email: sourceEmail,
      password: sourcePassword,
      displayName,
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
    const { access, config } = context();
    run.prepared = await prepareArrival(page, {
      issuer: config.issuer,
      mailpitUrl: access.mailpitUrl,
      did: run.source.did,
      handle: run.destinationHandle,
      email: destinationEmail,
    });
    await onPrepared?.(page);
  });
}
