import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createServer, connect } from "node:net";
import pg from "pg";
import { openDatabase } from "../../dist/src/database/connection.js";
import {
  createLifecycle,
  loadLifecycleConfiguration,
} from "../../dist/src/http/lifecycle.js";
import {
  openTestDatabase,
  testDatabaseConfiguration,
  query,
} from "../support/database-fixture.mjs";

const barrier = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const configuration = { probeTimeoutMs: 50, shutdownTimeoutMs: 300 };
async function serverFixture(
  t,
  probe = async () => true,
  options = configuration,
) {
  const lifecycle = createLifecycle({ probe, configuration: options });
  const app = express();
  app.get("/_health", (_req, res) => res.json({ status: "ok" }));
  app.get("/_readyz", lifecycle.readiness);
  app.use(lifecycle.admission);
  let mutations = 0;
  app.post("/mutate", (_req, res) => {
    mutations++;
    res.json({ mutations });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    lifecycle,
    server,
    app,
    mutations: () => mutations,
    request: (path, options) =>
      fetch(`http://127.0.0.1:${server.address().port}${path}`, options),
  };
}

test("lifecycle configuration bounds are explicit and invalid values fail startup", () => {
  assert.deepEqual(loadLifecycleConfiguration({}), {
    probeTimeoutMs: 2000,
    shutdownTimeoutMs: 15000,
  });
  for (const value of ["0", "-1", "no", "1.5", "10001"])
    assert.throws(
      () => loadLifecycleConfiguration({ DATABASE_PROBE_TIMEOUT_MS: value }),
      /InvalidLifecycleConfiguration/,
    );
});

test("initialization, failed authority and drain refuse admission while liveness survives", async (t) => {
  let usable = true;
  const f = await serverFixture(t, async () => usable);
  assert.equal((await f.request("/_health")).status, 200);
  assert.equal((await f.request("/_readyz")).status, 503);
  assert.equal((await f.request("/mutate", { method: "POST" })).status, 503);
  f.lifecycle.initialize();
  const ready = await f.request("/_readyz");
  assert.equal(ready.status, 200);
  assert.equal(
    ready.headers.get("x-entryway-instance"),
    f.lifecycle.instanceId,
  );
  assert.equal((await f.request("/mutate", { method: "POST" })).status, 200);
  usable = false;
  assert.equal((await f.request("/mutate", { method: "POST" })).status, 503);
  usable = true;
  f.lifecycle.beginDrain();
  assert.equal((await f.request("/_readyz")).status, 503);
  assert.equal((await f.request("/mutate", { method: "POST" })).status, 503);
  assert.equal(f.mutations(), 1);
});

test("a ready probe completing after drain cannot admit a waiting request or worker", async (t) => {
  const entered = barrier(),
    release = barrier();
  const f = await serverFixture(t, async () => {
    entered.resolve();
    await release.promise;
    return true;
  });
  f.lifecycle.initialize();
  const request = f.request("/mutate", { method: "POST" });
  await entered.promise;
  f.lifecycle.beginDrain();
  let worked = false;
  await f.lifecycle.runWorker("mail", async () => {
    worked = true;
  });
  release.resolve();
  assert.equal((await request).status, 503);
  assert.equal(f.mutations(), 0);
  assert.equal(worked, false);
});

test("a client socket closed during the authority probe never starts downstream work", async (t) => {
  const entered = barrier(),
    release = barrier(),
    responseClosed = barrier();
  const f = await serverFixture(t, async () => {
    entered.resolve();
    await release.promise;
    return true;
  });
  f.server.on("request", (_request, response) =>
    response.once("close", responseClosed.resolve),
  );
  f.lifecycle.initialize();
  const controller = new AbortController();
  const request = f.request("/mutate", {
    method: "POST",
    signal: controller.signal,
  });
  const aborted = assert.rejects(request, { name: "AbortError" });
  await entered.promise;
  controller.abort();
  await aborted;
  await responseClosed.promise;
  release.resolve();
  await new Promise((done) => setImmediate(done));
  assert.equal(f.mutations(), 0);
  let closed = false;
  assert.equal(
    await f.lifecycle.stop(f.server, async () => {
      closed = true;
    }),
    "complete",
  );
  assert.equal(closed, true);
});

test("normal completed request bodies remain admissible after a held probe", async (t) => {
  const entered = barrier(),
    release = barrier(),
    bodyComplete = barrier();
  const f = await serverFixture(t, async () => {
    entered.resolve();
    await release.promise;
    return true;
  });
  f.server.on("request", (request) => {
    request.once("end", bodyComplete.resolve);
    request.resume();
  });
  f.lifecycle.initialize();
  const request = f.request("/mutate", {
    method: "POST",
    body: "complete body",
  });
  await Promise.all([entered.promise, bodyComplete.promise]);
  release.resolve();
  assert.equal((await request).status, 200);
  assert.equal(f.mutations(), 1);
});

test("an already-admitted request remains tracked after client loss until the shutdown deadline", async (t) => {
  const entered = barrier(),
    release = barrier(),
    responseClosed = barrier();
  const f = await serverFixture(t, async () => true, {
    ...configuration,
    shutdownTimeoutMs: 30,
  });
  f.app.post("/held", async (_request, response) => {
    entered.resolve();
    await release.promise;
    response.json({ status: "complete" });
  });
  f.server.on("request", (_request, response) =>
    response.once("close", responseClosed.resolve),
  );
  f.lifecycle.initialize();
  const controller = new AbortController();
  const request = f.request("/held", {
    method: "POST",
    signal: controller.signal,
  });
  const aborted = assert.rejects(request, { name: "AbortError" });
  await entered.promise;
  controller.abort();
  await aborted;
  await responseClosed.promise;
  let closed = false;
  assert.equal(
    await f.lifecycle.stop(f.server, async () => {
      closed = true;
    }),
    "deadline",
  );
  assert.equal(closed, false);
  release.resolve();
  await new Promise((done) => setImmediate(done));
  assert.equal(closed, false);
});

test("coalesced workers drain before storage closes and repeated stop shares the result", async (t) => {
  const entered = barrier(),
    release = barrier();
  const f = await serverFixture(t);
  f.lifecycle.initialize();
  let starts = 0,
    closed = 0;
  const work = () => {
    starts++;
    entered.resolve();
    return release.promise;
  };
  const first = f.lifecycle.runWorker("mail", work);
  assert.equal(f.lifecycle.runWorker("mail", work), first);
  await entered.promise;
  const stop = f.lifecycle.stop(f.server, async () => {
    closed++;
  });
  assert.equal(
    f.lifecycle.stop(f.server, async () => {
      closed++;
    }),
    stop,
  );
  await f.lifecycle.runWorker("other", async () => {
    starts++;
  });
  assert.equal(closed, 0);
  release.resolve();
  assert.equal(await stop, "complete");
  assert.equal(starts, 1);
  assert.equal(closed, 1);
});

test("shutdown deadline does not close storage beneath unfinished SMTP or restart work", async (t) => {
  const entered = barrier(),
    release = barrier();
  const f = await serverFixture(t, async () => true, {
    ...configuration,
    shutdownTimeoutMs: 30,
  });
  f.lifecycle.initialize();
  const work = f.lifecycle.runWorker("mail", async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let closed = 0;
  assert.equal(
    await f.lifecycle.stop(f.server, async () => {
      closed++;
    }),
    "deadline",
  );
  assert.equal(closed, 0);
  release.resolve();
  await work;
  await new Promise((done) => setImmediate(done));
  assert.equal(closed, 0);
});

test("database probe verifies the live schema and refuses a closed authority", async (t) => {
  const db = await openTestDatabase();
  t.after(() => db.close());
  assert.equal(await db.probe(500), true);
  assert.equal(await db.probe(0), false);
  await db.close();
  assert.equal(await db.probe(500), false);
});

test(
  "SQLite queued probes expire without joining an authority transaction or accumulating work",
  { skip: process.env.CONTRACT_DATABASE_BACKEND === "postgresql" },
  async (t) => {
    const db = await openTestDatabase();
    t.after(() => db.close());
    const entered = barrier(),
      release = barrier();
    const transaction = db.transact(async () => {
      await db.set("probe-test", "value", "uncommitted");
      entered.resolve();
      await release.promise;
      throw new Error("ExpectedRollback");
    });
    const rolledBack = assert.rejects(transaction, /ExpectedRollback/);
    await entered.promise;
    const started = performance.now();
    assert.deepEqual(
      await Promise.all(Array.from({ length: 20 }, () => db.probe(20))),
      Array(20).fill(false),
    );
    assert.equal(performance.now() - started < 250, true);
    release.resolve();
    await rolledBack;
    assert.equal(await db.get("probe-test", "value"), null);
    assert.equal(await db.probe(500), true);
  },
);

const postgresOnly = {
  skip: process.env.CONTRACT_DATABASE_BACKEND !== "postgresql",
};
test(
  "SQLite native lock waiting respects the physical probe deadline and recovers",
  { skip: process.env.CONTRACT_DATABASE_BACKEND === "postgresql" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "entryway-probe-lock-"));
    const path = join(directory, "authority.sqlite");
    const db = await openDatabase({ backend: "sqlite", path });
    await query(db, "PRAGMA journal_mode = DELETE");
    const holder = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require('better-sqlite3');
      const db = new Database(workerData);
      db.exec('BEGIN EXCLUSIVE');
      parentPort.postMessage('locked');
      parentPort.once('message', () => {
        db.exec('ROLLBACK'); db.close(); parentPort.close();
      });
    `,
      { eval: true, workerData: path },
    );
    t.after(async () => {
      await holder.terminate();
      await db.close();
      await rm(directory, { recursive: true, force: true });
    });
    assert.deepEqual(await once(holder, "message"), ["locked"]);
    const started = performance.now();
    assert.equal(await db.probe(75), false);
    assert.equal(performance.now() - started < 500, true);
    const released = once(holder, "exit");
    holder.postMessage("release");
    assert.deepEqual(await released, [0]);
    assert.equal(await db.probe(500), true);
  },
);
test(
  "PostgreSQL probe bounds physical connection and query waits, cleans up and recovers",
  postgresOnly,
  async (t) => {
    const configuration = await testDatabaseConfiguration();
    const upstream = new URL(configuration.url);
    const sockets = new Set();
    let mode = "normal",
      connections = 0,
      blocked;
    const proxy = createServer((downstream) => {
      connections++;
      sockets.add(downstream);
      downstream.on("error", () => {});
      downstream.on("close", () => sockets.delete(downstream));
      if (mode === "connect") {
        downstream.on("data", () => blocked?.resolve());
        return;
      }
      const remote = connect({
        host: upstream.hostname,
        port: Number(upstream.port || 5432),
      });
      remote.on("error", () => downstream.destroy());
      downstream.on("close", () => remote.destroy());
      remote.on("close", () => downstream.destroy());
      remote.pipe(downstream);
      downstream.on("data", (chunk) => {
        // The real driver has completed PostgreSQL startup/authentication before
        // its simple-query message. Withhold that message, never fake a DB reply.
        if (mode === "query" && chunk[0] === 81) blocked?.resolve();
        else remote.write(chunk);
      });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const url = new URL(upstream);
    url.hostname = "127.0.0.1";
    url.port = String(proxy.address().port);
    const db = await openDatabase({ backend: "postgresql", url: String(url) });
    t.after(async () => {
      await db.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => proxy.close(done));
    });
    for (const fault of ["query", "connect"]) {
      mode = fault;
      blocked = barrier();
      const before = connections;
      const started = performance.now();
      const first = db.probe(150);
      await blocked.promise;
      const overlapping = Array.from({ length: 20 }, () => db.probe(30));
      assert.equal(await first, false);
      assert.deepEqual(await Promise.all(overlapping), Array(20).fill(false));
      assert.equal(performance.now() - started < 1000, true);
      assert.equal(connections - before, 1);
      // Cleanup is asynchronous at the TCP peer. Wait for actual closure rather
      // than launching another probe while the one physical flight still drains.
      const deadline = performance.now() + 1000;
      while (sockets.size > 1 && performance.now() < deadline)
        await new Promise((done) => setTimeout(done, 5));
      assert.equal(sockets.size, 1);
      mode = "normal";
      assert.equal(await db.probe(500), true);
    }
  },
);

test(
  "PostgreSQL probe releases its physical transport when a peer withholds graceful closure",
  postgresOnly,
  async (t) => {
    const configuration = await testDatabaseConfiguration();
    const upstream = new URL(configuration.url);
    const sockets = new Set();
    let withholdClose = false;
    let connections = 0;
    const closedByClient = barrier();
    const proxy = createServer({ allowHalfOpen: true }, (downstream) => {
      connections++;
      sockets.add(downstream);
      downstream.on("error", () => {});
      downstream.on("close", () => sockets.delete(downstream));
      const remote = connect({
        host: upstream.hostname,
        port: Number(upstream.port || 5432),
      });
      remote.on("error", () => downstream.destroy());
      downstream.on("close", () => remote.destroy());
      remote.on("close", () => downstream.destroy());
      remote.pipe(downstream);
      downstream.on("data", (chunk) => {
        // Real startup and schema replies pass through. Withhold only pg's
        // Terminate message and the peer FIN, after the successful query.
        if (!(withholdClose && chunk[0] === 88)) remote.write(chunk);
      });
      downstream.on("end", () => {
        if (withholdClose) closedByClient.resolve();
        else downstream.end();
      });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const url = new URL(upstream);
    url.hostname = "127.0.0.1";
    url.port = String(proxy.address().port);
    const db = await openDatabase({ backend: "postgresql", url: String(url) });
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await db.close();
      await new Promise((done) => proxy.close(done));
    });
    withholdClose = true;
    const before = connections;
    const started = performance.now();
    assert.equal(await db.probe(150), true);
    await closedByClient.promise;
    assert.equal(performance.now() - started < 1000, true);
    assert.equal(connections - before, 1);
    // No fault repair or forced peer close: a fresh physical probe must work.
    assert.equal(await db.probe(150), true);
    assert.equal(connections - before, 2);
  },
);

test(
  "PostgreSQL idle client failure is contained and later authority reads recover",
  postgresOnly,
  async (t) => {
    const configuration = await testDatabaseConfiguration();
    const db = await openDatabase(configuration);
    const admin = new pg.Client({ connectionString: configuration.url });
    await admin.connect();
    t.after(async () => {
      await admin.end();
      await db.close();
    });
    await db.set("idle-recovery", "value", "retained");
    const [{ pid }] = await query(db, "SELECT pg_backend_pid() AS pid");
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    const deadline = performance.now() + 1000;
    let recovered = false;
    while (!recovered && performance.now() < deadline) {
      try {
        recovered = (await db.get("idle-recovery", "value")) === "retained";
      } catch {
        await new Promise((done) => setTimeout(done, 5));
      }
    }
    assert.equal(recovered, true);
    assert.equal(await db.probe(500), true);
  },
);
