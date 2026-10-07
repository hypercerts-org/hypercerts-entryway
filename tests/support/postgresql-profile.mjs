// Managed one-node application profile. Secrets and cookies stay in /profile.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadConfig } from "../../dist/src/config.mjs";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createAccountStorage } from "../../dist/src/database/drizzle/account-storage.js";
import { waitForMailpitCode } from "./helpers/mailpit.mjs";
import { candidateIdentity } from "./candidate-identity.mjs";
import { query } from "./database-inspection.mjs";
const stage = process.argv[2];
assert.ok(["login", "restart", "restore"].includes(stage));
const config = await loadConfig();
assert.equal(config.database.backend, "postgresql");
assert.equal(process.env.DEPLOYMENT_MODE, "single-node");
assert.equal(
  existsSync("/entryway-data/account-authority.sqlite"),
  false,
  "PostgreSQL profile must not create a SQLite fallback",
);
const db = await openDatabase(config.database);
const storage = createAccountStorage(db, config.pds);
const account = {
  did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  email: "database-profile@example.test",
  handle: `database-profile${config.handleDomains[0]}`,
  pdsId: config.pds[0].id,
  pdsUrl: config.pds[0].url,
  status: "active",
};
await mkdir("/profile", { recursive: true, mode: 0o700 });
let state =
  stage === "login"
    ? { cookies: {} }
    : JSON.parse(await readFile("/profile/session.json", "utf8"));
async function request(path, body) {
  const response = await fetch(new URL(path, config.issuer), {
    method: body ? "POST" : "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: {
      cookie: Object.entries(state.cookies)
        .map(([key, value]) => `${key}=${value}`)
        .join("; "),
      ...(body
        ? {
            origin: config.issuer,
            "content-type": "application/x-www-form-urlencoded",
          }
        : {}),
    },
    body: body ? new URLSearchParams(body) : undefined,
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0],
      split = pair.indexOf("=");
    state.cookies[pair.slice(0, split)] = pair.slice(split + 1);
  }
  return response;
}
const fields = (html) =>
  Object.fromEntries(
    ["flow", "csrf"].map((name) => {
      const value = new RegExp(`name="${name}" value="([^"]+)"`).exec(
        html,
      )?.[1];
      assert.ok(value, `Missing ${name} browser field`);
      return [name, value];
    }),
  );
try {
  if (stage === "login") {
    // This profile starts from an existing hosted authority row. It verifies
    // login and persistence, not account signup or external migration support.
    await storage.insertAccount(account);
    const login = await request("/login");
    assert.equal(login.status, 200);
    const form = fields(await login.text()),
      since = Date.now();
    const sent = await request("/auth/email", {
      ...form,
      email: account.email,
    });
    assert.equal(sent.status, 200);
    const { code } = await waitForMailpitCode({
      recipient: account.email,
      since,
    });
    const verified = await request("/auth/verify", { ...form, otp: code });
    assert.equal(verified.status, 303);
    assert.equal(verified.headers.get("location"), "/account");
    state.binding = await storage.getVerifiedBinding(account.did);
    assert.ok(state.binding?.userId);
    state.sessionIds = (await db.read("session")).map((row) => row.id).sort();
    assert.ok(state.sessionIds.length);
    await writeFile("/profile/session.json", JSON.stringify(state), {
      mode: 0o600,
    });
  }
  const page = await request("/account");
  assert.equal(
    page.status,
    200,
    "Existing authenticated browser must survive lifecycle transition",
  );
  assert.ok((await page.text()).includes(account.email));
  assert.deepEqual(
    await storage.getVerifiedBinding(account.did),
    state.binding,
  );
  assert.deepEqual(
    (await db.read("session")).map((row) => row.id).sort(),
    state.sessionIds,
  );
  assert.equal((await storage.getByDid(account.did)).email, account.email);
  const selected = await query(
    db,
    "SELECT current_database() AS name",
    [],
    "get",
  );
  assert.equal(
    selected.name,
    stage === "restore" ? "account_authority_restored" : "account_authority",
  );
  await writeFile(
    `/app/artifacts/postgresql-profile-${stage}.json`,
    JSON.stringify(
      {
        stage,
        backend: db.backend,
        deploymentMode: "single-node",
        selectedDatabase: selected.name,
        status: "passed",
        sqliteFallback: false,
        cases: [
          "actual-main-startup",
          "real-http-email-otp",
          "real-mailpit-delivery",
          "browser-session-and-DID-binding-retained",
        ],
        fixture: "existing hosted account row, not a signup/migration claim",
        identity: candidateIdentity(),
      },
      null,
      2,
    ),
  );
  console.log(`PostgreSQL single-node ${stage}: passed`);
} finally {
  await db.close();
}
