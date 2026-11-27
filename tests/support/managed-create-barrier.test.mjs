import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";
import {
  createManagedCreateBarrier,
  managedCreateBarrierFetch,
} from "./managed-create-barrier.mjs";

const origin = "https://destination.example";
const target = `${origin}/xrpc/com.atproto.server.createAccount`;

test("managed create barrier pauses only the first exact route and forwards it unchanged", async () => {
  const barrier = await createManagedCreateBarrier({ timeoutMs: 1000 });
  const calls = [];
  const response = new Response("stand-in", { status: 201 });
  const fetch = managedCreateBarrierFetch({
    origin,
    directory: barrier.directory,
    timeoutMs: 1000,
    fetch: async (...args) => {
      calls.push(args);
      return response;
    },
  });
  try {
    const options = { method: "POST", body: Symbol("opaque") };
    const pending = fetch(target, options);
    await barrier.reached();
    assert.equal(calls.length, 0);
    for (const [url, init] of [
      [target, { method: "GET" }],
      [target.replace(origin, "https://other.example"), options],
      [`${target}/other`, options],
      [target, options],
    ])
      assert.equal(await fetch(url, init), response);
    assert.equal(calls.length, 4);
    await barrier.release();
    assert.equal(await pending, response);
    assert.equal(calls.length, 5);
    assert.equal(calls[4][0], target);
    assert.equal(calls[4][1], options);
  } finally {
    await barrier.cleanup();
  }
  await assert.rejects(access(barrier.directory), { code: "ENOENT" });
});

test("managed create barrier bounds both waits and cleanup after errors", async () => {
  const barrier = await createManagedCreateBarrier({ timeoutMs: 30 });
  let calls = 0;
  const fetch = managedCreateBarrierFetch({
    origin,
    directory: barrier.directory,
    timeoutMs: 30,
    fetch: async () => {
      calls++;
    },
  });
  try {
    await assert.rejects(barrier.reached(), /timed out/);
    await assert.rejects(fetch(target, { method: "POST" }), /timed out/);
    assert.equal(calls, 0);
  } finally {
    await barrier.cleanup();
  }
  await assert.rejects(access(barrier.directory), { code: "ENOENT" });
});
