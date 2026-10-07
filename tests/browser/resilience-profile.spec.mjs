import { test, expect } from "@playwright/test";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { createPublicKey, randomUUID } from "node:crypto";
import { SignJWT, importJWK, exportJWK } from "jose";
import { loadConfig } from "../../dist/src/config.mjs";
import { openDatabase } from "../../dist/src/database/connection.js";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";
import { candidateIdentity } from "../support/candidate-identity.mjs";
const config = await loadConfig();
const stage = process.env.PROFILE_STAGE;
const label = process.env.PROFILE_LABEL ?? stage;
const count = Number(process.env.ENTRYWAY_PROFILE_NODE_COUNT);
const nodes = ["entryway", ...(count === 2 ? ["entryway-replica"] : [])];
const other = nodes.at(-1);
const select = (node) => ({ "x-profile-node": node });
const configuration =
  config.database.backend === "sqlite"
    ? { backend: "sqlite", path: "/entryway-data/account-authority.sqlite" }
    : config.database;
const observed = [];
const record = async (response, expectedNode) => {
  expect(response.status()).toBeLessThan(500);
  const id = response.headers()["x-entryway-instance"];
  expect(typeof id === "string" && id.length > 0).toBe(true);
  observed.push({
    phase: stage,
    path: new URL(response.url()).pathname,
    expectedNode,
    instanceId: id,
    status: response.status(),
  });
};
async function waitMarker(name, bound = 30_000) {
  const deadline = Date.now() + bound;
  while (Date.now() < deadline) {
    try {
      await access(`/app/artifacts/${name}`);
      return;
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error(`Missing profile controller marker: ${name}`);
}
async function marker(name, value = { status: "ready" }) {
  await writeFile(`/app/artifacts/${name}`, JSON.stringify(value));
}
async function signin(page, identity, create = false) {
  await page.context().setExtraHTTPHeaders(select(nodes[0]));
  const opened = await page.goto(`${config.issuer}/login`);
  await record(opened, nodes[0]);
  await page.getByLabel("Email address").fill(identity.email);
  const since = Date.now();
  const requested = page.waitForResponse(
    (r) =>
      r.url() === `${config.issuer}/auth/email` &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await record(await requested, nodes[0]);
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  const { code } = await waitForMailpitCode({
    recipient: identity.email,
    since,
  });
  await page.context().setExtraHTTPHeaders(select(other));
  await page.getByLabel("Sign-in code").fill(code);
  const verified = page.waitForResponse(
    (r) =>
      r.url() === `${config.issuer}/auth/verify` &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Verify code" }).click();
  await record(await verified, other);
  if (create) {
    await expect(
      page.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();
    await page.getByLabel("Handle", { exact: true }).fill(identity.handle);
    await page
      .getByLabel("Personal data server")
      .selectOption(config.pds[0].id);
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
  }
  await expect(
    page.getByRole("heading", { name: "Account settings" }),
  ).toBeVisible();
  const did = await page.getByTestId("account-did").textContent();
  if (identity.did) expect(did).toBe(identity.did);
  else identity.did = did;
  await page.context().setExtraHTTPHeaders(select(nodes[0]));
  await record(await page.goto(`${config.issuer}/account`), nodes[0]);
  await expect(page.getByTestId("account-did")).toHaveText(identity.did);
}
async function authorize(page, identity, { newProof = false } = {}) {
  const login = new URL("/client/login", config.clientUrl);
  login.searchParams.set("identifier", config.issuer);
  login.searchParams.set("prompt", "consent");
  await page.goto(String(login));
  const form = page.locator('form[action="/auth/consent"]').filter({
    has: page.locator(`input[name="did"][value="${identity.did}"]`),
  });
  if (newProof) {
    await expect(
      page.getByRole("heading", { name: "Sign in to authorize" }),
    ).toBeVisible();
    await expect(form).toHaveCount(0);
    await page.getByLabel("Email address").fill(identity.email);
    const since = Date.now();
    await page.getByRole("button", { name: "Send sign-in code" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    const { code } = await waitForMailpitCode({
      recipient: identity.email,
      since,
    });
    await page.getByLabel("Sign-in code").fill(code);
    await page.getByRole("button", { name: "Verify code" }).click();
  }
  await expect(form).toBeVisible();
  await form.getByRole("button", { name: "Allow access" }).click();
  await expect(page.getByTestId("signed-in-did")).toHaveText(identity.did);
}
async function clientSession(page) {
  const response = await page.request.get(
    `${config.clientUrl}/client/session?client=primary`,
  );
  expect(response.status()).toBe(200);
  return response.json();
}
async function writeRecord(page, identity, label) {
  const current = await clientSession(page);
  const response = await page.request.post(`${config.clientUrl}/client/write`, {
    data: { client: "primary", text: label },
    headers: { origin: config.clientUrl, "x-csrf-token": current.csrf },
  });
  expect(response.status()).toBe(200);
  const value = await response.json();
  expect(
    typeof value.uri === "string" &&
      value.uri.startsWith(`at://${identity.did}/`),
  ).toBe(true);
  const [, , , collection, rkey] = value.uri.split("/");
  const record = await fetch(
    `${config.pds[0].url}/xrpc/com.atproto.repo.getRecord?${new URLSearchParams({ repo: identity.did, collection, rkey })}`,
  );
  expect(record.status).toBe(200);
  expect((await record.json()).value.text).toBe(label);
}
async function captureCode(page, db, identity) {
  let callback;
  const endpoint = `${config.issuer}/auth/consent`;
  const intercept = async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    expect(response.status()).toBe(303);
    callback = new URL(response.headers().location);
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<h1>Callback held for protocol validation</h1>",
    });
  };
  await page.route(endpoint, intercept);
  try {
    const login = new URL("/client/login", config.clientUrl);
    login.searchParams.set("identifier", config.issuer);
    login.searchParams.set("prompt", "consent");
    await page.goto(String(login));
    await page
      .locator('form[action="/auth/consent"]')
      .filter({
        has: page.locator(`input[name="did"][value="${identity.did}"]`),
      })
      .getByRole("button", { name: "Allow access" })
      .click();
    await expect.poll(() => Boolean(callback)).toBe(true);
  } finally {
    await page.unroute(endpoint, intercept);
  }
  const state = (
    await db.get("client:primary:states", callback.searchParams.get("state"))
  ).value;
  return {
    state,
    parameters: {
      grant_type: "authorization_code",
      code: callback.searchParams.get("code"),
      redirect_uri: `${config.clientUrl}/client/callback`,
      code_verifier: state.verifier,
    },
  };
}
async function rawGrant(db, dpopJwk, parameters, node) {
  const clientJwk = await db.get("client:keys", "primary");
  const clientKey = await importJWK(clientJwk, "ES256");
  const clientId = `${config.clientUrl}/client-metadata.json`;
  const algorithm =
    dpopJwk.alg ??
    (dpopJwk.crv === "P-256"
      ? "ES256"
      : dpopJwk.crv === "secp256k1"
        ? "ES256K"
        : "RS256");
  const dpopKey = await importJWK(dpopJwk, algorithm);
  const publicDpop = await exportJWK(createPublicKey(dpopKey));
  let nonce;
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({
      iss: clientId,
      sub: clientId,
      aud: config.issuer,
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
    })
      .setProtectedHeader({ alg: "ES256", kid: clientJwk.kid, typ: "JWT" })
      .sign(clientKey);
    const proof = await new SignJWT({
      jti: randomUUID(),
      iat: now,
      htm: "POST",
      htu: `${config.issuer}/oauth/token`,
      ...(nonce ? { nonce } : {}),
    })
      .setProtectedHeader({ typ: "dpop+jwt", alg: algorithm, jwk: publicDpop })
      .sign(dpopKey);
    const response = await fetch(`${config.issuer}/oauth/token`, {
      method: "POST",
      headers: {
        ...select(node),
        "content-type": "application/x-www-form-urlencoded",
        dpop: proof,
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_assertion_type:
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
        ...parameters,
      }),
    });
    const body = await response.json();
    nonce = response.headers.get("dpop-nonce");
    observed.push({
      phase: stage,
      path: "/oauth/token",
      expectedNode: node,
      instanceId: response.headers.get("x-entryway-instance"),
      status: response.status,
    });
    if (body.error === "use_dpop_nonce" && attempt === 0) continue;
    return { status: response.status, body };
  }
  throw Error("DPoP negotiation failed");
}

test(`fresh deployment profile ${stage}`, async ({ browser }) => {
  await mkdir("/profile", { recursive: true, mode: 0o700 });
  const db =
    stage === "database-refusal" ? null : await openDatabase(configuration);
  const identity =
    stage === "journey"
      ? {
          email: `profile-${randomUUID()}@example.test`,
          handle: `profile-${randomUUID().slice(0, 8)}${config.handleDomains[0]}`,
        }
      : JSON.parse(await readFile("/profile/identity.json", "utf8"));
  const context = await browser.newContext({
    ignoreHTTPSErrors: false,
    ...(stage === "journey" || stage === "database-refusal"
      ? {}
      : { storageState: "/profile/browser.json" }),
  });
  const page = await context.newPage();
  try {
    if (stage === "journey") {
      const topology = await (
        await fetch(`${config.issuer}/__profile/nodes`)
      ).json();
      expect(topology.nodes.length).toBe(count);
      expect(topology.nodes.every((node) => node.ready)).toBe(true);
      expect(new Set(topology.nodes.map((node) => node.instanceId)).size).toBe(
        count,
      );
      const metadata = await Promise.all(
        nodes.map(async (node) => {
          const response = await fetch(
            `${config.clientUrl}/client-metadata.json`,
            {
              headers: select(node),
              signal: AbortSignal.timeout(3000),
            },
          );
          expect(response.status).toBe(200);
          const value = await response.json();
          expect(value.jwks.keys.length).toBeGreaterThan(0);
          return value;
        }),
      );
      expect(
        metadata.every(
          (value) => JSON.stringify(value) === JSON.stringify(metadata[0]),
        ),
      ).toBe(true);
      await signin(page, identity, true);
      await authorize(page, identity);
      await writeRecord(page, identity, "Fresh profile OAuth write");
      await context.storageState({ path: "/profile/browser.json" });
      await writeFile("/profile/identity.json", JSON.stringify(identity), {
        mode: 0o600,
      });
      // A second browser proves returning OTP, crossing issue/verify nodes.
      const returning = await browser.newContext({ ignoreHTTPSErrors: false });
      try {
        await signin(await returning.newPage(), identity);
      } finally {
        await returning.close();
      }
      const saved = await db.get("client:primary:sessions", identity.did);
      const rotated = await rawGrant(
        db,
        saved.dpopJwk,
        {
          grant_type: "refresh_token",
          refresh_token: saved.tokenSet.refresh_token,
        },
        other,
      );
      expect(rotated.status).toBe(200);
      const replay = await rawGrant(
        db,
        saved.dpopJwk,
        {
          grant_type: "refresh_token",
          refresh_token: saved.tokenSet.refresh_token,
        },
        nodes[0],
      );
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe("invalid_grant");
      const family = await rawGrant(
        db,
        saved.dpopJwk,
        {
          grant_type: "refresh_token",
          refresh_token: rotated.body.refresh_token,
        },
        other,
      );
      expect(family.status).toBe(400);
      expect(family.body.error).toBe("invalid_grant");
      const code = await captureCode(page, db, identity);
      const exchanged = await rawGrant(
        db,
        code.state.dpopJwk,
        code.parameters,
        other,
      );
      expect(exchanged.status).toBe(200);
      const codeReplay = await rawGrant(
        db,
        code.state.dpopJwk,
        code.parameters,
        nodes[0],
      );
      expect(codeReplay.status).toBe(400);
      expect(codeReplay.body.error).toBe("invalid_grant");
      const revokedByReplay = await rawGrant(
        db,
        code.state.dpopJwk,
        {
          grant_type: "refresh_token",
          refresh_token: exchanged.body.refresh_token,
        },
        other,
      );
      expect(revokedByReplay.status).toBe(400);
      expect(revokedByReplay.body.error).toBe("invalid_grant");
      await authorize(page, identity, { newProof: true });
      const beforeRevoke = await db.get(
        "client:primary:sessions",
        identity.did,
      );
      await context.setExtraHTTPHeaders(select(nodes[0]));
      await page.goto(`${config.issuer}/account`);
      await page
        .locator('form[action="/account/grant-revoke"]')
        .filter({
          has: page.locator(
            `input[name="clientId"][value="${config.clientUrl}/client-metadata.json"]`,
          ),
        })
        .getByRole("button", { name: "Revoke application access" })
        .click();
      const revoked = await rawGrant(
        db,
        beforeRevoke.dpopJwk,
        {
          grant_type: "refresh_token",
          refresh_token: beforeRevoke.tokenSet.refresh_token,
        },
        other,
      );
      expect(revoked.status).toBe(400);
      expect(revoked.body.error).toBe("invalid_grant");
      // Reauthorize after deliberate family replay so lifecycle checks retain a
      // usable independent OAuth session. All credentials stay private.
      await authorize(page, identity);
      await context.storageState({ path: "/profile/browser.json" });
      await writeRecord(page, identity, "Profile write after replay isolation");
      const actual = new Map(
        topology.nodes.map((node) => [node.node, node.instanceId]),
      );
      expect(
        observed.every(
          (receipt) => receipt.instanceId === actual.get(receipt.expectedNode),
        ),
      ).toBe(true);
    } else if (stage === "survivor" || stage === "rejoin") {
      await context.setExtraHTTPHeaders(
        select(process.env.PROFILE_SURVIVOR ?? other),
      );
      await record(
        await page.goto(`${config.issuer}/account`),
        process.env.PROFILE_SURVIVOR ?? other,
      );
      await expect(page.getByTestId("account-did")).toHaveText(identity.did);
      await page.goto(`${config.clientUrl}/client`);
      await expect(page.getByTestId("signed-in-did")).toHaveText(identity.did);
      await writeRecord(page, identity, `Profile ${stage} PDS write`);
    } else {
      await context.setExtraHTTPHeaders(select(nodes[0]));
      await page.goto(`${config.issuer}/login`);
      const draft = `draft-${randomUUID()}@example.test`;
      await page.getByLabel("Email address").fill(draft);
      await marker("database-fault-browser-ready.json");
      await waitMarker("database-fault-active.json");
      await page.getByRole("button", { name: "Send sign-in code" }).click();
      await expect(
        page.getByRole("heading", { name: "Service temporarily unavailable" }),
      ).toBeVisible();
      await expect(page.getByRole("alert")).toHaveText(
        "This request was not started.",
      );
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("button", { name: "Return to previous page" }),
      ).toBeFocused();
      await page.screenshot({
        path: "/app/artifacts/profile-unavailable-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: "/app/artifacts/profile-unavailable-narrow.png",
        fullPage: true,
      });
      // The controller proves every backend has left the ready ingress set.
      // Without this barrier an ordinary request can reach a stale-ready app
      // and render the application's 503 instead of the ingress fallback.
      await waitMarker("readiness-lost.json");
      const ordinary = await browser.newContext({ ignoreHTTPSErrors: false });
      try {
        const unavailablePage = await ordinary.newPage();
        const fallback = await unavailablePage.goto(`${config.issuer}/login`);
        expect(fallback.status()).toBe(503);
        expect(fallback.headers()["x-entryway-instance"]).toBeUndefined();
        await expect(
          unavailablePage.getByText("No ready server is available.", {
            exact: false,
          }),
        ).toBeVisible();
        await expect(unavailablePage.getByRole("alert")).toHaveText(
          "This request was not started.",
        );
        await unavailablePage.keyboard.press("Tab");
        await expect(
          unavailablePage.getByRole("button", {
            name: "Return to previous page",
          }),
        ).toBeFocused();
        await unavailablePage.screenshot({
          path: "/app/artifacts/profile-ingress-unavailable-desktop.png",
          fullPage: true,
        });
        await unavailablePage.setViewportSize({ width: 390, height: 844 });
        await unavailablePage.screenshot({
          path: "/app/artifacts/profile-ingress-unavailable-narrow.png",
          fullPage: true,
        });
      } finally {
        await ordinary.close();
      }
      await marker("database-fault-refusal.json");
      await waitMarker("database-fault-recovered.json");
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Email address")).toHaveValue(draft);
      const since = Date.now();
      await page.getByRole("button", { name: "Send sign-in code" }).click();
      await expect(
        page.getByRole("heading", { name: "Check your email" }),
      ).toBeVisible();
      const { code } = await waitForMailpitCode({ recipient: draft, since });
      await page.getByLabel("Sign-in code").fill(code);
      await page.getByRole("button", { name: "Verify code" }).click();
      await expect(
        page.getByRole("heading", { name: "Create your account" }),
      ).toBeVisible();
    }
    const mainWorkerClaims =
      stage === "journey"
        ? (await db.read("external_operation_attempts")).map((attempt) => ({
            id: attempt.id,
            operationId: attempt.operation_id,
            method: attempt.method,
            state: attempt.state,
            workerId: attempt.worker_id,
          }))
        : undefined;
    if (mainWorkerClaims) {
      expect(mainWorkerClaims.length).toBeGreaterThan(0);
      const serving = new Set(observed.map((request) => request.instanceId));
      expect(
        mainWorkerClaims.every((claim) => serving.has(claim.workerId)),
      ).toBe(true);
    }
    await marker(`profile-${label}.json`, {
      status: "passed",
      stage,
      backend: config.database.backend,
      deploymentMode: process.env.DEPLOYMENT_MODE,
      nodeCount: count,
      coldMetadataConsistent: stage === "journey" ? true : undefined,
      mainWorkerClaims,
      observed,
      identity: candidateIdentity(),
    });
  } catch (error) {
    await marker(`profile-${label}-failure-context.json`, {
      stage,
      path: new URL(page.url()).pathname,
      heading: await page
        .locator("h1")
        .allTextContents()
        .catch(() => []),
      fields: await page
        .locator("input[name]")
        .evaluateAll((inputs) =>
          inputs.map((input) => ({
            name: input.getAttribute("name"),
            type: input.getAttribute("type"),
          })),
        )
        .catch(() => []),
    }).catch(() => {});
    throw error;
  } finally {
    await db?.close();
    await context.close();
  }
});
