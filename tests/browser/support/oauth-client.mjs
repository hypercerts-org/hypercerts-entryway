import { expect } from "@playwright/test";
import { waitForMailpitCode } from "../../support/helpers/mailpit.mjs";
import { config } from "../../support/helpers/browser-oauth.mjs";

export { config };
export const databasePath =
  process.env.TEST_ACCOUNT_DATABASE_PATH ??
  "/entryway-data/account-authority.sqlite";

export function consentForm(page, did) {
  return page
    .locator('form[action="/auth/consent"]')
    .filter({ has: page.locator(`input[name="did"][value="${did}"]`) });
}

export function selectionForm(page, did) {
  return page
    .locator('form[action="/auth/select"]')
    .filter({ has: page.locator(`input[name="did"][value="${did}"]`) });
}

/**
 * Start an OAuth authorization through the synthetic client's login route.
 * The sandbox clients are `primary`, `secondary` (trusted, skips consent on
 * signup) and `untrusted` (opts in to the skip without being trusted).
 */
export async function beginAuthorization(
  page,
  { client = "primary", identifier = config.issuer, prompt, email } = {},
) {
  const login = new URL("/client/login", config.clientUrl);
  login.searchParams.set("identifier", identifier);
  login.searchParams.set("client", client);
  if (prompt) login.searchParams.set("prompt", prompt);
  if (email) login.searchParams.set("email", email);
  await page.goto(login.href);
}

export async function requestVisibleCode(page, email) {
  const since = Date.now();
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  return waitForMailpitCode({ recipient: email, since });
}

export async function verifyVisibleCode(page, code) {
  await page.getByLabel("Sign-in code").fill(code);
  await page.getByRole("button", { name: "Verify code" }).click();
}

export async function finishConsent(page, did) {
  await consentForm(page, did)
    .getByRole("button", { name: "Allow access" })
    .click();
  await expect(page.getByTestId("signed-in-did")).toHaveText(did);
}

/**
 * Assert the primary client's session subject, token audience and an
 * account-scoped write for `account`. `headers` apply to both client calls, for
 * example to select a deployment-profile node; the responses are returned so
 * callers can inspect where each call was served.
 */
export async function assertOAuthSubjectAndWrite(
  page,
  account,
  { text, headers = {} },
) {
  const session = await page.request.get(
    `${config.clientUrl}/client/session?client=primary`,
    { headers },
  );
  expect(session.ok(), await session.text()).toBeTruthy();
  const current = await session.json();
  // The OAuth client session DID is the subject returned by the token exchange.
  expect(current.did).toBe(account.did);
  const pds = config.pds.find(({ id }) => id === account.pdsId);
  expect(new URL(current.tokenInfo.aud).href).toBe(new URL(pds.url).href);

  const write = await page.request.post(`${config.clientUrl}/client/write`, {
    headers: {
      ...headers,
      origin: config.clientUrl,
      "x-csrf-token": current.csrf,
    },
    data: { client: "primary", text },
  });
  expect(write.ok(), await write.text()).toBeTruthy();
  expect((await write.json()).uri).toContain(`at://${account.did}/`);
  return { session, write };
}
