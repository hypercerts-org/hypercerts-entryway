import { test, expect } from "@playwright/test";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";
import { createAccount } from "../support/helpers/browser-oauth.mjs";
import { setAccountPassword } from "./support/account-password.mjs";
import { bindAccountsToSharedEmail } from "./support/email-chooser-fixture.mjs";
import {
  config,
  databasePath,
  requestVisibleCode,
  verifyVisibleCode,
} from "./support/oauth-client.mjs";

const runId = Date.now().toString(36);
const password = `Shared lookups ${runId} password!`;
const xrpc = (name) => `${config.issuer}/xrpc/com.atproto.server.${name}`;
const unknownEmail = `nobody-${runId}@example.test`;

let first;
let second;
let single;
let apiContext;
let api;

async function createAccountInNewContext(browser, label, { withPassword }) {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const page = await context.newPage();
    const account = await createAccount(page, label);
    if (withPassword) {
      await page.locator('a[href^="/account/manage/password?"]').click();
      await setAccountPassword(page, password);
    }
    return account;
  } finally {
    await context.close();
  }
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  first = await createAccountInNewContext(browser, "lookup-a", {
    withPassword: true,
  });
  second = await createAccountInNewContext(browser, "lookup-b", {
    withPassword: true,
  });
  single = await createAccountInNewContext(browser, "lookup-c", {
    withPassword: false,
  });
  await bindAccountsToSharedEmail({
    first,
    second: { ...second, pdsId: config.pds[0].id },
    email: first.email,
    databasePath,
  });
  apiContext = await browser.newContext({ ignoreHTTPSErrors: false });
  api = apiContext.request;
});

test.afterAll(async () => apiContext?.close());

test("password login with a shared email fails like an unknown email while handle and DID sign in", async () => {
  const login = (identifier) =>
    api.post(xrpc("createSession"), { data: { identifier, password } });

  const unknown = await login(unknownEmail);
  expect(unknown.status()).toBe(401);
  const shared = await login(first.email);
  expect(shared.status()).toBe(401);
  expect(await shared.json()).toEqual(await unknown.json());

  for (const [identifier, did] of [
    [first.handle, first.did],
    [first.did, first.did],
    [second.handle, second.did],
    [second.did, second.did],
  ]) {
    const session = await login(identifier);
    expect(session.ok(), identifier).toBe(true);
    expect((await session.json()).did).toBe(did);
  }
});

test("password reset for a shared email sends no mail, unlike a single-account email", async () => {
  const reset = (email) =>
    api.post(xrpc("requestPasswordReset"), { data: { email } });

  const controlSince = Date.now();
  expect((await reset(single.email)).ok()).toBe(true);
  await waitForMailpitCode({ recipient: single.email, since: controlSince });

  const since = Date.now();
  const shared = await reset(first.email);
  expect(shared.ok()).toBe(true);
  expect(await shared.json()).toEqual(await (await reset(unknownEmail)).json());
  await expect(
    waitForMailpitCode({ recipient: first.email, since, timeoutMs: 2_000 }),
  ).rejects.toThrow("Timed out");
});

test("signup with a shared email returns AccountExists", async ({
  browser,
}) => {
  // A browser session verified for the shared email can ask to sign up with it.
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const page = await context.newPage();
    await page.goto(`${config.issuer}/login`);
    const message = await requestVisibleCode(page, first.email);
    await verifyVisibleCode(page, message.code);
    await expect(
      page.getByRole("heading", { name: "Choose an account" }),
    ).toBeVisible();
    const signup = await page.request.post(xrpc("createAccount"), {
      data: {
        email: first.email,
        handle: `sl-${runId}.entryway.atmosbox.test`,
        pdsId: config.pds[0].id,
      },
    });
    expect(signup.status()).toBe(409);
    expect((await signup.json()).error).toBe("AccountExists");
  } finally {
    await context.close();
  }
});
