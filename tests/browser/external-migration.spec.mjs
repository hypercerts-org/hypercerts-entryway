import { test, expect } from "@playwright/test";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";
import { readFileSync, writeFileSync } from "node:fs";
const config = JSON.parse(
  readFileSync(process.env.SERVICE_CONFIG_PATH, "utf8"),
);
const reportPath = "artifacts/external-migration.json";
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const identity = report.identity;
test("external account verifies its destination email, then uses OAuth on the cluster", async ({
  page,
}) => {
  await page.goto(`${config.issuer}/login`);
  await page.getByLabel("Email address", { exact: true }).fill(identity.email);
  const since = Date.now();
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  const { code } = await waitForMailpitCode({
    recipient: identity.email,
    since,
  });
  await page.getByLabel("Sign-in code").fill(code);
  await page.getByRole("button", { name: "Verify code" }).click();
  if (process.env.EXTERNAL_PHASE === "prepare") {
    if (!["account-bound", "complete"].includes(report.phase))
      await expect(
        page.getByRole("heading", { name: "Create your account", exact: true }),
      ).toBeVisible();
    else
      await expect(
        page.getByRole("heading", { name: "Home", exact: true }),
      ).toBeVisible();
    return;
  }
  expect(report.status).toBe("passed");
  await expect(
    page.getByRole("heading", { name: "Home", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("account-did")).toHaveText(identity.did);
  await page.goto(
    `${config.clientUrl}/client/login?identifier=${encodeURIComponent(identity.handle)}`,
  );
  const consent = page.locator('form[action="/auth/consent"]').filter({
    has: page.locator(`input[name="did"][value="${identity.did}"]`),
  });
  await expect(consent.or(page.getByTestId("signed-in-did"))).toBeVisible();
  if (await consent.isVisible())
    await consent.getByRole("button", { name: "Allow access" }).click();
  await expect(page.getByTestId("signed-in-did")).toHaveText(identity.did);
  const sessionResponse = await page.request.get(
    `${config.clientUrl}/client/session?client=primary`,
  );
  expect(sessionResponse.ok()).toBe(true);
  const session = await sessionResponse.json();
  expect(new URL(session.tokenInfo.aud).origin).toBe(report.target);
  const headers = { origin: config.clientUrl, "x-csrf-token": session.csrf };
  const write = await page.request.post(`${config.clientUrl}/client/write`, {
    headers,
    data: { client: "primary", text: "OAuth write after external migration" },
  });
  expect(write.ok(), await write.text()).toBe(true);
  expect((await write.json()).uri).toContain(`at://${identity.did}/`);
  const refresh = await page.request.post(
    `${config.clientUrl}/client/refresh`,
    { headers, data: { client: "primary" } },
  );
  expect(refresh.ok(), await refresh.text()).toBe(true);
  expect((await refresh.json()).did).toBe(identity.did);
  await page.screenshot({
    path: "artifacts/external-migration-oauth.png",
    fullPage: true,
  });
  const latest = JSON.parse(readFileSync(reportPath, "utf8"));
  latest.browser = {
    status: "passed",
    tlsVerified: true,
    emailOtp: true,
    sameDid: true,
    audience: report.target,
    oauthWrite: true,
    refresh: true,
    at: new Date().toISOString(),
  };
  writeFileSync(reportPath, JSON.stringify(latest, null, 2) + "\n");
});
