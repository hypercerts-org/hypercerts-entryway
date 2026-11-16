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
  await page.getByLabel("Sign-in code").fill(login.code);
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
  await page.getByLabel("Fresh email code").fill(fresh.code);
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
