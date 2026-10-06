import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

const config = JSON.parse(
  readFileSync(
    process.env.SERVICE_CONFIG_PATH ?? "./.runtime/config.json",
    "utf8",
  ),
);
const mailbox = new DatabaseSync(
  process.env.TEST_ACCOUNT_DATABASE_PATH ??
    "/entryway-data/account-authority.sqlite",
  { readOnly: true },
);
const mail = (email) => {
  const row = mailbox
    .prepare("SELECT value FROM key_value_state WHERE namespace=? AND key=?")
    .get("outbox", email);
  return row ? JSON.parse(row.value) : null;
};
const accountForm = (page, action) =>
  page.locator(`form[action="/account/${action}"]`);
const recoveryRun = process.env.MANAGED_RECOVERY_RUN;
const recoveryMode = process.env.MANAGED_RECOVERY_MODE ?? "consumed-success";
const run = recoveryRun ?? Date.now().toString(36);
const identity = {
  email: `migration-console-${run}@example.com`,
  handle: `migration-${run}.entryway.atmosbox.test`,
};
const source = config.pds.find((p) => p.id === "pds1");
const target = config.pds.find((p) => p.id === "pds2");

async function signIn(page, create = false, pendingMigration = false) {
  await page.goto(`${config.issuer}/login`);
  await page.getByLabel("Email address", { exact: true }).fill(identity.email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await expect.poll(() => mail(identity.email)?.type).toBe("sign-in");
  await page.getByLabel("Sign-in code").fill(mail(identity.email).otp);
  await page.getByRole("button", { name: "Verify code" }).click();
  if (create) {
    await page.getByLabel("Handle", { exact: true }).fill(identity.handle);
    await page.getByLabel("Personal data server").selectOption(source.id);
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
  }
  if (pendingMigration) {
    await expect(
      page.getByRole("heading", { name: "Account unavailable", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Open account settings" }).click();
  }
  await expect(
    page.getByRole("heading", { name: "Account settings", exact: true }),
  ).toBeVisible();
}
async function appSession(page, pds, name) {
  await accountForm(page, "app-password-create")
    .getByLabel("App password name")
    .fill(name);
  await accountForm(page, "app-password-create").getByRole("button").click();
  const password = await page.getByTestId("app-password").textContent();
  const result = await page.request.post(
    `${pds.url}/xrpc/com.atproto.server.createSession`,
    {
      data: { identifier: identity.handle, password },
    },
  );
  expect(result.ok()).toBe(true);
  return result.json();
}
const recordInput = (did, text, attachment) => ({
  repo: did,
  collection: "org.hypercerts.spike.note",
  validate: false,
  record: {
    $type: "org.hypercerts.spike.note",
    text,
    createdAt: new Date().toISOString(),
    ...(attachment ? { attachment } : {}),
  },
});

test.afterAll(() => mailbox.close());

test("console migrates its own DID, record and blob between enrolled PDSs with mailbox proof", async ({
  page,
}) => {
  if (recoveryRun) test.setTimeout(180000);
  await signIn(page, true);
  const did = await page.getByTestId("account-did").textContent();
  const oldSession = await appSession(page, source, `Migration source ${run}`);
  const oldAuth = { authorization: `Bearer ${oldSession.accessJwt}` };
  const bytes = Buffer.from(`Entryway migration browser fixture ${run}\n`);
  const upload = await page.request.post(
    `${source.url}/xrpc/com.atproto.repo.uploadBlob`,
    {
      headers: { ...oldAuth, "content-type": "text/plain" },
      data: bytes,
    },
  );
  expect(upload.ok()).toBe(true);
  const { blob } = await upload.json();
  const created = await page.request.post(
    `${source.url}/xrpc/com.atproto.repo.createRecord`,
    {
      headers: oldAuth,
      data: recordInput(did, `Before migration ${run}`, blob),
    },
  );
  expect(created.ok()).toBe(true);
  const record = await created.json();

  await page.goto(`${config.issuer}/account`);
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  const forbiddenTarget = await page.request.post(
    `${config.issuer}/account/migration-request`,
    {
      headers: { origin: config.issuer },
      form: { csrf, pdsId: "https://unregistered.example.com" },
      maxRedirects: 0,
    },
  );
  expect(forbiddenTarget.status()).toBe(400);
  await accountForm(page, "migration-request")
    .getByLabel("Destination data server")
    .selectOption(target.id);
  await accountForm(page, "migration-request").getByRole("button").click();
  await expect(
    page.getByRole("heading", { name: "Confirm data server migration" }),
  ).toBeVisible();
  await expect.poll(() => mail(identity.email)?.type).toBe("account-migrate");
  const token = mail(identity.email).token;
  expect(typeof token === "string" && token.includes(".")).toBe(true);
  const invalid = await page.request.post(
    `${config.issuer}/account/migration-confirm`,
    {
      headers: { origin: config.issuer },
      form: { csrf, pdsId: target.id, token: "invalid.code" },
      maxRedirects: 0,
    },
  );
  expect(invalid.status()).toBe(400);
  await page.getByLabel("Migration code").fill(token);
  await accountForm(page, "migration-confirm").getByRole("button").click();
  if (recoveryRun) {
    const prefix = `artifacts/managed-recovery-${recoveryRun}`;
    // The original authenticated request returned. Source freeze intentionally
    // revokes that session, so return through a fresh verified browser session.
    await expect(page.getByRole("alert")).toContainText("uncertain");
    await signIn(page, false, true);
    await page.reload();
    await expect(page.getByTestId("account-did")).toHaveText(did);
    await expect(page.locator("#migration")).toContainText(target.url);
    await expect(page.locator("#migration")).toContainText(
      "Contact the service operator",
    );
    await expect(
      page.getByRole("button", { name: "Waiting for operator recovery" }),
    ).toBeDisabled();
    const retry = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/account/migration-confirm" &&
        response.request().method() === "POST",
    );
    await accountForm(page, "migration-confirm").evaluate((form) =>
      form.requestSubmit(),
    );
    expect((await retry).status()).toBe(409);
    await expect(
      page.getByRole("heading", { name: "Data server migration is pending" }),
    ).toBeVisible();
    await expect(page.locator("main")).toContainText(did);
    await expect(page.locator("main")).toContainText(target.url);
    await expect(page.getByRole("alert")).toContainText(
      "retrying alone cannot resolve",
    );
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("link", { name: "Return to account settings" }),
    ).toBeFocused();
    for (const [label, width, height] of [
      ["desktop", 1280, 900],
      ["narrow", 390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `${prefix}-pending-${label}.png`,
        fullPage: true,
      });
    }
    const proof = JSON.parse(readFileSync(`${prefix}-response.json`, "utf8"));
    expect(proof.did).toBe(did);
    expect(proof.upstreamResponseConsumed).toBe(true);
    expect(proof.fault).toBe(recoveryMode);
    expect(proof.upstreamStatus).toBe(
      recoveryMode === "consumed-success" ? 200 : 401,
    );
    expect(proof.method).toBe("com.atproto.server.createAccount");
    const headers = {
      authorization: `Basic ${Buffer.from(`admin:${config.adminPassword}`).toString("base64")}`,
    };
    const status = await page.request.post(
      `${config.issuer}/_operations/status`,
      { headers, data: { resource: did } },
    );
    expect(status.status()).toBe(200);
    const pending = await status.json();
    expect(pending.status).toBe("recovery-required");
    expect(pending.attempt.target).toBe(target.url);
    expect(pending.attempt.method).toBe(proof.method);
    const { operationId, externalAttemptId, executionAttemptId } =
      pending.attempt;
    const approval = {
      operationId,
      externalAttemptId,
      executionAttemptId,
      target: target.url,
      action: "observe",
      dispatcherIsolationReference: `managed-recovery:${recoveryRun}:original-http-request-returned`,
      upstreamDrainReference: `managed-recovery:${recoveryRun}:original-response-consumed`,
    };
    const approved = await page.request.post(
      `${config.issuer}/_operations/recovery`,
      { headers, data: approval },
    );
    expect(approved.status()).toBe(200);
    expect((await approved.json()).pending).toBe(true);
    await page.goto(`${config.issuer}/account`);
    const resume = page.getByRole("button", {
      name: "Resume data server migration",
    });
    if (await resume.count()) await resume.click();
    let upgrade = null;
    if (recoveryMode === "rejected-request") {
      await expect(
        page.getByRole("heading", { name: "Data server migration is pending" }),
      ).toBeVisible();
      await expect(page.locator("main")).toContainText(did);
      await expect(page.locator("main")).toContainText(target.url);
      const inspected = await (
        await page.request.post(`${config.issuer}/_operations/status`, {
          headers,
          data: { resource: did },
        })
      ).json();
      expect(inspected.attempt.externalAttemptId).toBe(externalAttemptId);
      expect(inspected.authorization.action).toBe("observe");
      expect(inspected.authorization.version).toBe(1);
      const attemptsBefore = mailbox
        .prepare(
          "SELECT id FROM external_operation_attempts WHERE operation_id=? AND step=?",
        )
        .all(operationId, pending.attempt.step);
      expect(attemptsBefore).toHaveLength(1);
      upgrade = {
        ...approval,
        action: "retry-if-safe",
        previousAuthorization: { id: inspected.authorization.id, version: 1 },
      };
      const upgraded = await page.request.post(
        `${config.issuer}/_operations/recovery`,
        { headers, data: upgrade },
      );
      expect(upgraded.status()).toBe(200);
      expect(
        (
          await page.request.post(`${config.issuer}/_operations/recovery`, {
            headers,
            data: upgrade,
          })
        ).status(),
      ).toBe(409);
      await page.goto(`${config.issuer}/account`);
      const retry = page.getByRole("button", {
        name: "Resume data server migration",
      });
      if (await retry.count()) await retry.click();
    }
    // The normal reconciler may also win continuation after approval. Either
    // path must complete the exact saved journal before sign-in and data checks.
    await expect
      .poll(() => {
        const row = mailbox
          .prepare(
            "SELECT value FROM key_value_state WHERE namespace=? AND key=?",
          )
          .get("migration:operations", `migrate:${did}`);
        return row && JSON.parse(row.value).phase;
      })
      .toBe("complete");
    if (upgrade) {
      const attempts = mailbox
        .prepare(
          "SELECT id,result,recovery FROM external_operation_attempts WHERE operation_id=? AND step=?",
        )
        .all(operationId, pending.attempt.step);
      expect(attempts).toHaveLength(2);
      const original = attempts.find(
        (attempt) => attempt.id === externalAttemptId,
      );
      expect(JSON.parse(original.result)).toEqual({ recovery: "unapplied" });
      const history = JSON.parse(original.recovery);
      expect(history.map((authorization) => authorization.action)).toEqual([
        "observe",
        "retry-if-safe",
      ]);
      expect(history[1].previousAuthorization).toEqual(
        upgrade.previousAuthorization,
      );
    }
    writeFileSync(
      `${prefix}-recovery.json`,
      JSON.stringify({
        did,
        target: target.url,
        operationId,
        externalAttemptId,
        originalHttpReturned: true,
        upstreamResponseConsumed: true,
        exactRecoveryApproved: true,
        fault: recoveryMode,
        upstreamStatus: proof.upstreamStatus,
        versionedUpgrade: Boolean(upgrade),
        savedContextAfterReload: true,
        retryHeld: true,
        keyboardFocus: true,
      }),
    );
  } else {
    await expect(
      page.getByRole("heading", { name: "Data server migration complete" }),
    ).toBeVisible();
  }
  const signedOut = await page.request.get(`${config.issuer}/account`, {
    maxRedirects: 0,
  });
  expect(signedOut.status()).toBe(303);

  await signIn(page);
  await expect(page.getByTestId("account-did")).toHaveText(did);
  await expect(page.locator("#identity")).toContainText(target.url);
  const rkey = record.uri.split("/").at(-1);
  const copiedRecord = await page.request.get(
    `${target.url}/xrpc/com.atproto.repo.getRecord`,
    {
      params: { repo: did, collection: "org.hypercerts.spike.note", rkey },
    },
  );
  expect(copiedRecord.ok()).toBe(true);
  const copied = await copiedRecord.json();
  expect(copied.cid).toBe(record.cid);
  const copiedBlob = await page.request.get(
    `${target.url}/xrpc/com.atproto.sync.getBlob`,
    {
      params: { did, cid: blob.ref.$link },
    },
  );
  expect(copiedBlob.ok()).toBe(true);
  expect((await copiedBlob.body()).equals(bytes)).toBe(true);
  const oldWrite = await page.request.post(
    `${source.url}/xrpc/com.atproto.repo.createRecord`,
    {
      headers: oldAuth,
      data: recordInput(did, "Source must remain frozen"),
    },
  );
  expect(oldWrite.ok()).toBe(false);

  const newSession = await appSession(
    page,
    target,
    `Migration destination ${run}`,
  );
  expect(newSession.did).toBe(did);
  const newWrite = await page.request.post(
    `${target.url}/xrpc/com.atproto.repo.createRecord`,
    {
      headers: { authorization: `Bearer ${newSession.accessJwt}` },
      data: recordInput(did, `After migration ${run}`),
    },
  );
  expect(newWrite.ok()).toBe(true);
  await page.goto(`${config.issuer}/account`);
  mkdirSync("artifacts", { recursive: true });
  await page.screenshot({
    path: recoveryRun
      ? `artifacts/managed-recovery-${recoveryRun}-complete.png`
      : "artifacts/migration-console-complete.png",
    fullPage: true,
  });
  if (recoveryRun)
    writeFileSync(
      `artifacts/managed-recovery-${recoveryRun}-result.json`,
      JSON.stringify({
        status: "passed",
        mode: recoveryMode,
        versionedUpgrade: recoveryMode === "rejected-request",
        did,
        sameDid: true,
        exactRecordCid: true,
        exactBlobBytes: true,
        oldSessionRejected: true,
        newSession: true,
        pdsWrite: true,
      }),
    );
});
