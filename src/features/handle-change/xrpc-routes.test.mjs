import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import { mountHandleChangeXrpc } from "../../../dist/src/features/handle-change/xrpc-routes.mjs";
import { requestFailureEvent } from "../../../dist/src/logging/request-event.js";

test("resolveHandle forwards a rejected reader through Express and serves the next request", async (t) => {
  const app = express();
  let unavailable = true;
  const failure = new Error("private database diagnostic");
  const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  mountHandleChangeXrpc({
    app,
    accounts: {
      async get() {
        if (unavailable) throw failure;
        return { did, status: "active" };
      },
    },
  });
  let forwarded;
  app.use((error, _req, res, _next) => {
    forwarded = error;
    const event = requestFailureEvent(500, error, "route-regression");
    res.status(event.status).json({ error: event.code });
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/xrpc/com.atproto.identity.resolveHandle?handle=alice.test`;
  const rejected = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(rejected.status, 500);
  assert.deepEqual(await rejected.json(), { error: "RequestFailed" });
  assert.equal(forwarded, failure);
  unavailable = false;
  const recovered = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { did });
});
