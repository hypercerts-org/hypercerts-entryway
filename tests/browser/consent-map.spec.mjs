// Sign-in and consent situations from the consent map that no other browser
// test drives end to end. Unit tests cover each branch with a fake provider;
// these prove the real provider and Entryway agree in a real browser.
//
// Sandbox apps: primary (trusted, no signup opt-in), secondary (trusted, opts
// in), untrusted (confidential, opts in, not trusted) and public (no client
// authentication, opts in, not trusted).
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openDatabase } from "../../dist/src/database/connection.js";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";

const config = JSON.parse(
  readFileSync(
    process.env.SERVICE_CONFIG_PATH ?? "./.runtime/config.json",
    "utf8",
  ),
);
const databasePath =
  process.env.TEST_ACCOUNT_DATABASE_PATH ??
  "/entryway-data/account-authority.sqlite";
const runId = Date.now().toString(36);
const identity = (name) => ({
  email: `consent-map-${runId}-${name}@example.test`,
  handle: `cm-${runId}-${name}.entryway.atmosbox.test`,
});

test.describe.configure({ mode: "serial" });

let context;
let page;
// Signed up in `context` through primary, so this browser remembers it fresh
// and the account has allowed primary.
const carol = identity("c");

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ ignoreHTTPSErrors: false });
  page = await context.newPage();
});
test.afterAll(async () => {
  await context?.close();
});

const loginUrl = ({ client, email, prompt }) => {
  const url = new URL("/client/login", config.clientUrl);
  url.searchParams.set("identifier", config.issuer);
  url.searchParams.set("client", client);
  if (email) url.searchParams.set("email", email);
  if (prompt) url.searchParams.set("prompt", prompt);
  return url.href;
};
const consentFor = (target, did) =>
  target
    .locator('form[action="/auth/consent"]')
    .filter({ has: target.locator(`input[name="did"][value="${did}"]`) });
const checkYourEmail = (target) =>
  target.getByRole("heading", { name: "Check your email" });
const signedInAs = (target) => target.getByTestId("signed-in-did");

async function enterEmailedCode(target, email, since) {
  const { code } = await waitForMailpitCode({ recipient: email, since });
  await target.getByLabel("Sign-in code").fill(code);
  await target.getByRole("button", { name: "Verify code" }).click();
}

// No new sign-in email arrives within a few seconds.
async function expectNoCodeSent(email, since) {
  await expect(
    waitForMailpitCode({ recipient: email, since, timeoutMs: 3_000 }),
  ).rejects.toThrow("Timed out");
}

// Signs up through `client` with prompt=create and stops after "Create
// account", leaving the page on whatever comes next.
async function signUp(target, client, account) {
  const since = Date.now();
  await target.goto(loginUrl({ client, prompt: "create" }));
  await target.getByLabel("Email address").fill(account.email);
  await target.getByRole("button", { name: "Send sign-in code" }).click();
  await expect(checkYourEmail(target)).toBeVisible();
  await enterEmailedCode(target, account.email, since);
  await expect(
    target.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  await target.getByLabel("Handle", { exact: true }).fill(account.handle);
  await target.getByRole("button", { name: "Create account" }).click();
}

// Backdates this account's remembered sessions past the seven-day freshness
// window. There is no product path to age a session, so the test edits the
// stored device-account record the provider reads on every authorization.
async function ageRememberedSessions(did) {
  const db = await openDatabase({ backend: "sqlite", path: databasePath });
  try {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    let aged = 0;
    for (const { key, value } of await db.list("oauth:device-accounts")) {
      if (value.did !== did) continue;
      await db.set("oauth:device-accounts", key, {
        ...value,
        createdAt: old,
        updatedAt: old,
      });
      aged++;
    }
    expect(aged).toBeGreaterThan(0);
  } finally {
    await db.close();
  }
}

test("setup: carol signs up through the primary app and allows it", async () => {
  await signUp(page, "primary", carol);
  const consent = page.locator('form[action="/auth/consent"]');
  await expect(consent).toBeVisible();
  carol.did = await consent.locator('input[name="did"]').inputValue();
  await consent.getByRole("button", { name: "Allow access" }).click();
  await expect(signedInAs(page)).toHaveText(carol.did);
});

test("email hint, browser not signed in: code, then consent even for an allowed app", async ({
  browser,
}) => {
  const fresh = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const other = await fresh.newPage();
    const since = Date.now();
    await other.goto(loginUrl({ client: "primary", email: carol.email }));
    await expect(checkYourEmail(other)).toBeVisible();
    await enterEmailedCode(other, carol.email, since);
    const consent = consentFor(other, carol.did);
    await expect(consent).toBeVisible();
    await consent.getByRole("button", { name: "Allow access" }).click();
    await expect(signedInAs(other)).toHaveText(carol.did);
  } finally {
    await fresh.close();
  }
});

test("email hint, signed in within 7 days, app allowed: signed in with no code or consent", async () => {
  const since = Date.now();
  await page.goto(loginUrl({ client: "primary", email: carol.email }));
  await expect(signedInAs(page)).toHaveText(carol.did);
  await expectNoCodeSent(carol.email, since);
});

test("email hint from a public app: consent without a code, even after allowing it", async () => {
  const since = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(loginUrl({ client: "public", email: carol.email }));
    const consent = consentFor(page, carol.did);
    await expect(consent).toBeVisible();
    await consent.getByRole("button", { name: "Allow access" }).click();
    await expect(signedInAs(page)).toHaveText(carol.did);
  }
  await expectNoCodeSent(carol.email, since);
});

test("no hint, signed in within 7 days: the remembered account is offered with Allow access", async () => {
  await page.goto(loginUrl({ client: "untrusted" }));
  await expect(
    page.getByRole("heading", { name: "Sign in to authorize" }),
  ).toBeVisible();
  await expect(page.getByLabel("Email address")).toBeVisible();
  const consent = consentFor(page, carol.did);
  await consent.getByRole("button", { name: "Allow access" }).click();
  await expect(signedInAs(page)).toHaveText(carol.did);
});

test("email hint, signed in over 7 days ago: code, then consent", async () => {
  await ageRememberedSessions(carol.did);
  const since = Date.now();
  await page.goto(loginUrl({ client: "primary", email: carol.email }));
  await expect(checkYourEmail(page)).toBeVisible();
  await enterEmailedCode(page, carol.email, since);
  const consent = consentFor(page, carol.did);
  await expect(consent).toBeVisible();
  await consent.getByRole("button", { name: "Allow access" }).click();
  await expect(signedInAs(page)).toHaveText(carol.did);
});

test("new account through a trusted app that opts in skips consent", async ({
  browser,
}) => {
  const fresh = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const other = await fresh.newPage();
    await signUp(other, "secondary", identity("s"));
    await expect(signedInAs(other)).toHaveText(/^did:plc:/);
    await expect(other.locator('form[action="/auth/consent"]')).toHaveCount(0);
  } finally {
    await fresh.close();
  }
});

for (const [client, name] of [
  ["untrusted", "u"],
  ["public", "p"],
]) {
  test(`new account through the ${client} app that opts in still sees consent`, async ({
    browser,
  }) => {
    const fresh = await browser.newContext({ ignoreHTTPSErrors: false });
    try {
      const other = await fresh.newPage();
      await signUp(other, client, identity(name));
      const consent = other.locator('form[action="/auth/consent"]');
      await expect(consent).toBeVisible();
      const did = await consent.locator('input[name="did"]').inputValue();
      await consent.getByRole("button", { name: "Allow access" }).click();
      await expect(signedInAs(other)).toHaveText(did);
    } finally {
      await fresh.close();
    }
  });
}
