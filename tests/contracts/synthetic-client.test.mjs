import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { NodeOAuthClient } from "@atproto/oauth-client-node";
import { mountClient } from "../../dist/tests/fixtures/synthetic-client.mjs";
import { openTestDatabase } from "../support/database-fixture.mjs";

const config = {
  clientUrl: "https://client.entryway.example.com",
  issuer: "https://entryway.example.com",
  plcUrl: "https://plc.example.com",
  pds: [{ url: "https://pds.example.com" }],
  handleDomains: [".entryway.example.com"],
};
const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const cookieName = "__Host-client-session";

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "client-persistence-"));
  const path = join(directory, "authority.sqlite");
  let db;
  let server;
  const result = {};
  async function close() {
    if (server) {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server = null;
    }
    await db?.close();
  }
  async function open() {
    db = await openTestDatabase(path);
    const app = express();
    const mounted = await mountClient({ app, db, config });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = `http://127.0.0.1:${server.address().port}`;
    Object.assign(result, mounted, {
      db,
      request: (route, options = {}) =>
        new Promise((resolve, reject) => {
          const request = httpRequest(
            `${address}${route}`,
            {
              method: options.method ?? "GET",
              headers: {
                host: new URL(config.clientUrl).hostname,
                accept: "application/json",
                ...options.headers,
              },
            },
            (response) => {
              const chunks = [];
              response.on("data", (chunk) => chunks.push(chunk));
              response.on("error", reject);
              response.on("end", () =>
                resolve(
                  new Response(Buffer.concat(chunks), {
                    status: response.statusCode,
                    headers: Object.fromEntries(
                      Object.entries(response.headers).map(([key, value]) => [
                        key,
                        Array.isArray(value) ? value.join(", ") : value,
                      ]),
                    ),
                  }),
                ),
              );
            },
          );
          request.on("error", reject);
          request.end(options.body);
        }),
    });
  }
  t.after(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  result.reopen = async () => {
    await close();
    await open();
  };
  await open();
  return result;
}

async function newBrowser(f) {
  const response = await f.request("/client");
  assert.equal(response.status, 200);
  await response.text();
  const cookieHeader = response.headers.get("set-cookie");
  // Avoid printing generated cookie/CSRF values in assertion diagnostics.
  assert.equal(typeof cookieHeader, "string");
  assert.equal(cookieHeader.includes("HttpOnly"), true);
  assert.equal(cookieHeader.includes("Secure"), true);
  assert.equal(cookieHeader.includes("SameSite=Lax"), true);
  const cookie = cookieHeader.split(";")[0];
  assert.equal(cookie.startsWith(`${cookieName}=`), true);
  const id = cookie.slice(cookieName.length + 1);
  const browser = await f.db.get("client:browsers", id);
  assert.equal(Boolean(browser), true);
  assert.equal(browser.id === id, true);
  assert.equal(typeof browser.csrf, "string");
  assert.equal(browser.csrf.length, 43);
  assert.deepEqual(browser.subjects, {});
  assert.equal(browser.client, "primary");
  assert.equal(browser.expiresAt > Date.now(), true);
  return { cookie, browser };
}

const publicKey = ({ kty, crv, x, y, alg, kid }) => ({
  kty,
  crv,
  x,
  y,
  alg,
  kid,
});

test("real client construction persists fresh keys and browser state across database reopen", async (t) => {
  const f = await fixture(t);
  assert.equal(f.clients.primary instanceof NodeOAuthClient, true);
  assert.equal(f.clients.secondary instanceof NodeOAuthClient, true);
  const keys = [];
  for (const id of ["primary", "secondary"]) {
    const key = await f.db.get("client:keys", id);
    assert.equal(Boolean(key), true);
    assert.equal(key.kid, `spike-client-${id}`);
    keys.push(publicKey(key));
  }
  const { cookie, browser } = await newBrowser(f);
  assert.equal((await f.db.list("client:browsers")).length, 1);
  await f.reopen();
  for (const [index, id] of ["primary", "secondary"].entries())
    assert.deepEqual(publicKey(await f.db.get("client:keys", id)), keys[index]);
  const response = await f.request("/client", { headers: { cookie } });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(response.headers.has("set-cookie"), false);
  const persisted = await f.db.get("client:browsers", browser.id);
  assert.equal(persisted.csrf === browser.csrf, true);
  assert.equal((await f.db.list("client:browsers")).length, 1);
});

test("client routes persist flow, callback, write and logout with controlled protocol responses", async (t) => {
  const f = await fixture(t);
  const { cookie, browser } = await newBrowser(f);
  const id = "secondary";
  const pds = "did:web:pds.example.com";
  const record = {
    uri: `at://${did}/org.hypercerts.spike.note/record`,
    cid: "fixture-cid",
  };
  const requests = [];
  let failSession = false;
  let failWrite = false;
  const session = {
    did,
    async getTokenInfo() {
      return { aud: pds };
    },
    async fetchHandler(path, init) {
      requests.push({ path, init });
      if (path === "/xrpc/com.atproto.server.getSession")
        return Response.json(
          failSession
            ? { error: "SessionUnavailable" }
            : { did, handle: "alice.entryway.example.com" },
          { status: failSession ? 502 : 200 },
        );
      assert.equal(path, "/xrpc/com.atproto.repo.createRecord");
      return Response.json(failWrite ? { error: "WriteUnavailable" } : record, {
        status: failWrite ? 502 : 200,
      });
    },
  };
  // These test-owned responses isolate fixture persistence/control flow. Real
  // NodeOAuthClient construction and both database adapters remain in use;
  // protocol conformance still belongs to the unchanged full browser gates.
  const client = f.clients[id];
  let appState;
  client.authorize = async (identifier, options) => {
    assert.equal(identifier, config.issuer);
    appState = options.state;
    const flow = await f.db.get("client:flows", appState);
    assert.equal(flow.browserId === browser.id, true);
    assert.equal(flow.client, id);
    await f.db.set(`client:${id}:states`, "controlled-state", {
      value: { appState },
      savedAt: Date.now(),
    });
    return new URL(`${config.issuer}/authorize`);
  };
  client.callback = async () => ({ state: appState, session });
  client.restore = async (subject) => {
    assert.equal(subject, did);
    return session;
  };
  async function login() {
    const response = await f.request(`/client/login?client=${id}`, {
      headers: { cookie },
    });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      `${config.issuer}/authorize`,
    );
    await response.text();
  }
  async function callback() {
    return f.request("/client/callback/secondary?state=controlled-state", {
      headers: { cookie },
    });
  }
  const post = (path, body = {}) =>
    f.request(path, {
      method: "POST",
      headers: {
        cookie,
        origin: config.clientUrl,
        "x-csrf-token": browser.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ client: id, ...body }),
    });

  const invalidPrompt = await f.request(
    `/client/login?client=${id}&prompt=invalid`,
    { headers: { cookie } },
  );
  assert.equal(invalidPrompt.status, 400);
  await invalidPrompt.json();
  assert.equal((await f.db.list("client:flows")).length, 0);

  await login();
  failSession = true;
  const failedCallback = await callback();
  assert.equal(failedCallback.status, 502);
  assert.equal((await failedCallback.json()).error, "SessionUnavailable");
  assert.equal(await f.db.get("client:flows", appState), null);
  assert.equal(await f.db.get("client:last-login", `${id}:${did}`), null);
  failSession = false;
  await login();
  const completed = await callback();
  assert.equal(completed.status, 303);
  assert.equal(completed.headers.get("location"), `/client?client=${id}`);
  await completed.text();
  const persisted = await f.db.get("client:browsers", browser.id);
  assert.equal(persisted.client, id);
  assert.deepEqual(persisted.subjects, { [id]: did });
  const lastLogin = await f.db.get("client:last-login", `${id}:${did}`);
  assert.equal(lastLogin.did, did);
  assert.equal(lastLogin.client, id);
  assert.equal(lastLogin.pds, pds);
  assert.equal(lastLogin.at instanceof Date, true);
  assert.equal(await f.db.get("client:flows", appState), null);

  failWrite = true;
  const failedWrite = await post("/client/write", { text: "fixture note" });
  assert.equal(failedWrite.status, 502);
  assert.equal((await failedWrite.json()).error, "WriteUnavailable");
  assert.equal(await f.db.get("client:last-write", `${id}:${did}`), null);
  failWrite = false;
  const written = await post("/client/write", { text: "fixture note" });
  assert.equal(written.status, 200);
  assert.deepEqual(await written.json(), { ok: true, ...record });
  const lastWrite = await f.db.get("client:last-write", `${id}:${did}`);
  assert.equal(lastWrite.uri, record.uri);
  assert.equal(lastWrite.cid, record.cid);
  assert.equal(lastWrite.did, did);
  assert.equal(lastWrite.at instanceof Date, true);
  const payload = JSON.parse(requests.at(-1).init.body);
  assert.equal(payload.repo, did);
  assert.equal(payload.record.text, "fixture note");

  client.revoke = async (subject) => {
    assert.equal(subject, did);
    throw Error("controlled revocation failure");
  };
  const failedRevoke = await post("/client/logout");
  assert.equal(failedRevoke.status, 502);
  assert.match((await failedRevoke.json()).message, /Signed out locally/);
  assert.deepEqual(
    (await f.db.get("client:browsers", browser.id)).subjects,
    {},
  );
  await login();
  await (await callback()).text();
  client.revoke = async (subject) => {
    assert.equal(subject, did);
  };
  const logout = await post("/client/logout");
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { ok: true });
  assert.deepEqual(
    (await f.db.get("client:browsers", browser.id)).subjects,
    {},
  );
});

test("simultaneous cold client instances share the committed public signing keys", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "client-cold-start-"));
  const path = join(directory, "authority.sqlite");
  const firstDb = await openTestDatabase(path);
  const secondDb =
    process.env.CONTRACT_DATABASE_BACKEND === "postgresql"
      ? await openTestDatabase(path)
      : firstDb;
  t.after(async () => {
    await firstDb.close();
    if (secondDb !== firstDb) await secondDb.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let enter, release;
  const entered = new Promise((done) => {
    enter = done;
  });
  const held = new Promise((done) => {
    release = done;
  });
  const captured = [[], []];
  let blocked = false;
  // Hold the first initialization after reading the absent key, while still in
  // its real authority transaction. A second instance must read the winner.
  const wrap = (db, index) => ({
    ...db,
    async get(namespace, key) {
      const value = await db.get(namespace, key);
      if (namespace === "client:keys") {
        if (index === 0 && key === "primary" && !blocked) {
          blocked = true;
          enter();
          await held;
        }
        captured[index].push(value && publicKey(value));
      }
      return value;
    },
  });
  const first = mountClient({ app: express(), db: wrap(firstDb, 0), config });
  await entered;
  const second = mountClient({ app: express(), db: wrap(secondDb, 1), config });
  // Inspect the second physical PG backend waiting for the first transaction
  // in the dedicated PostgreSQL process contracts; this barrier proves the
  // client-specific absent-read interleaving without exposing private keys.
  release();
  const clients = await Promise.all([first, second]);
  assert.equal(
    clients.every((item) => item.clients.primary instanceof NodeOAuthClient),
    true,
  );
  for (const [index, id] of ["primary", "secondary"].entries()) {
    assert.deepEqual(
      captured[1][index],
      publicKey(await firstDb.get("client:keys", id)),
    );
  }
});
