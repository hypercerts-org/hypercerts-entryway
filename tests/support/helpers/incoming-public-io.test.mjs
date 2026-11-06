import test from "node:test";
import assert from "node:assert/strict";
import {
  ResponseBodyError,
  ResponseStatusError,
  createIncomingPublicIo,
  runHeldStreamedCall,
} from "./incoming-public-io.mjs";

const jsonResponse = (body, status = 200) => {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return new Response(bytes, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(bytes.byteLength),
    },
  });
};

const carResponse = (chunks, { declared } = {}) => {
  const stream = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
        await Promise.resolve();
      }
      controller.close();
    },
  });
  const headers = { "content-type": "application/vnd.ipld.car" };
  if (declared !== undefined) headers["content-length"] = String(declared);
  return new Response(stream, { status: 200, headers });
};

const hangingResponse = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const within = async (promise, limitMs) => {
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve({ pending: true }), limitMs),
    ),
  ]);
  assert.equal(outcome.pending, undefined, "Operation must settle in time");
  return outcome;
};

const disposalOrderingResponse = (disposed) => ({
  status: 204,
  ok: true,
  headers: new Headers(),
  body: {
    getReader: () => ({
      read: () => Promise.resolve({ done: true, value: undefined }),
      cancel: () => {
        disposed.push("reader");
        return Promise.resolve();
      },
    }),
    cancel: () => {
      disposed.push("body");
      return Promise.resolve();
    },
  },
});

const guardedStreamResponse = ({ ready = {} } = {}) => {
  const guard = (name) => {
    if (!ready[name]) throw new Error(`Stream ${name} is not ready`);
  };
  const state = { cancelled: false };
  const response = {
    status: 200,
    ok: true,
    headers: new Headers({ "content-type": "application/vnd.ipld.car" }),
    body: {
      getReader: () => {
        guard("getReader");
        return {
          read: () => {
            guard("read");
            return new Promise(() => {});
          },
          cancel: (reason) => {
            guard("cancel");
            state.cancelled = true;
            state.reason = reason;
            return Promise.resolve();
          },
        };
      },
      cancel: (reason) => {
        guard("cancel");
        state.cancelled = true;
        state.reason = reason;
        return Promise.resolve();
      },
    },
  };
  return { response, state };
};

test("injected response headers overrun the phase deadline", async () => {
  const stalls = [];
  const io = createIncomingPublicIo({
    timeoutMs: 40,
    fetch: (_url, init) => {
      init.signal.addEventListener("abort", () => stalls.push(Date.now()));
      return new Promise(() => {});
    },
  });
  const started = Date.now();
  const outcome = await within(
    io.call("https://pds.example/xrpc/a", { expect: "status" }),
    1_000,
  );
  assert.ok(outcome.error, "A stalled header read must reject");
  assert.ok(Date.now() - started < 1_000, "Rejection must be prompt");
  assert.equal(stalls.length, 1, "The deadline must abort the fetch");
  await io.close();
});

test("status consumption stays pending until the body is disposed", async () => {
  const disposed = [];
  let dispose;
  const disposalGate = new Promise((resolve) => {
    dispose = resolve;
  });
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: async () => {
      const response = disposalOrderingResponse(disposed);
      response.body.cancel = () => {
        disposed.push("body");
        return disposalGate;
      };
      return response;
    },
  });
  const pending = io.call("https://pds.example/xrpc/a", { expect: "status" });
  const settledEarly = await Promise.race([
    pending.then(
      () => "settled",
      () => "settled",
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
  ]);
  assert.equal(
    settledEarly,
    "pending",
    "The call must not resolve before the body is disposed",
  );
  assert.deepEqual(disposed, ["body"], "Disposal must be under way");
  dispose();
  assert.equal(await pending, 204);
  await io.close();
});

test("a null status body succeeds without disposal", async () => {
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: async () => new Response(null, { status: 204 }),
  });
  assert.equal(
    await io.call("https://pds.example/xrpc/a", { expect: "status" }),
    204,
  );
  await io.close();
});

test("a status body disposed under deadline cannot stall the caller", async () => {
  let disposed = false;
  const io = createIncomingPublicIo({
    timeoutMs: 40,
    fetch: async () => {
      const response = disposalOrderingResponse([]);
      response.body.cancel = () => {
        disposed = true;
        return new Promise(() => {});
      };
      return response;
    },
  });
  const started = Date.now();
  const outcome = await within(
    io.call("https://pds.example/xrpc/a", { expect: "status" }),
    1_000,
  );
  assert.ok(outcome.error, "An undisposable body must reject, not hang");
  assert.ok(Date.now() - started < 1_000, "Rejection must stay bounded");
  assert.equal(disposed, true, "Disposal must still have been attempted");
  await io.close();
});

test("cancelling a status call rejects within its deadline and disposes", async () => {
  const disposed = [];
  const controller = new AbortController();
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: async () => disposalOrderingResponse(disposed),
  });
  const pending = io.call("https://pds.example/xrpc/a", {
    expect: "status",
    signal: controller.signal,
  });
  controller.abort(new Error("status cancelled"));
  const outcome = await within(pending, 1_000);
  assert.equal(outcome.error?.message, "status cancelled");
  await within(io.close(), 1_000);
  assert.deepEqual(
    disposed,
    ["body"],
    "A cancelled call must still release its body",
  );
});

test("deadline stays active across a stalled JSON body", async () => {
  const io = createIncomingPublicIo({
    timeoutMs: 40,
    fetch: async () => hangingResponse(),
  });
  const started = Date.now();
  const outcome = await within(
    io.call("https://pds.example/xrpc/a", { expect: "json" }),
    1_000,
  );
  assert.ok(outcome.error, "A stalled JSON body must reject");
  assert.ok(Date.now() - started < 1_000, "Rejection must be prompt");
  await io.close();
});

test("deadline stays active across a stalled CAR body", async () => {
  let cancelled = false;
  const io = createIncomingPublicIo({
    timeoutMs: 40,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/vnd.ipld.car" },
        },
      ),
  });
  const started = Date.now();
  const outcome = await within(
    io.call("https://pds.example/xrpc/a", { expect: "car" }),
    1_000,
  );
  assert.ok(outcome.error, "A stalled CAR body must reject");
  assert.ok(Date.now() - started < 1_000, "Rejection must be prompt");
  assert.equal(cancelled, true, "The stalled stream must be cancelled");
  await io.close();
});

test("phase deadline releases a CAR reader that never completes", async () => {
  let cancelled = false;
  const io = createIncomingPublicIo({
    timeoutMs: 40,
    fetch: async (_url, init) => {
      init.signal.addEventListener("abort", () => {
        cancelled = true;
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/vnd.ipld.car" },
        },
      );
    },
  });
  const outcome = await within(
    io.call("https://pds.example/xrpc/a", { expect: "car" }),
    1_000,
  );
  assert.ok(outcome.error);
  assert.equal(cancelled, true, "The abort path must release the reader");
  await io.close();
});

test("tracking covers response consumption until settlement", async () => {
  let settles;
  const gate = new Promise((resolve) => {
    settles = resolve;
  });
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: async () => {
      await gate;
      return jsonResponse({ ok: true });
    },
  });
  const pending = io.call("https://pds.example/xrpc/a", { expect: "json" });
  assert.equal(io.inflight.size, 1, "In-flight work is tracked");
  settles();
  assert.deepEqual(await pending, { ok: true });
  await Promise.resolve();
  assert.equal(io.inflight.size, 0, "Settled work is untracked");
  await io.close();
});

test("teardown aborts in-flight work before bounded settlement", async () => {
  let abortedAtTeardown = false;
  let transportSignal;
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        transportSignal = init.signal;
        transportSignal.addEventListener("abort", () =>
          reject(init.signal.reason),
        );
      }),
  });
  const pending = io.call("https://pds.example/xrpc/a", {
    expect: "status",
  });
  const observed = [];
  const closing = io.close({ settleTimeoutMs: 1_000 }).then(() => {
    abortedAtTeardown = transportSignal.aborted;
    observed.push("settled");
  });
  assert.equal(
    transportSignal.aborted,
    true,
    "Teardown must abort the transport before it waits for settlement",
  );
  await assert.rejects(pending);
  await closing;
  assert.equal(abortedAtTeardown, true);
  assert.deepEqual(observed, ["settled"]);
  assert.equal(io.inflight.size, 0);
});

test("teardown waits on request settlement, not only on abort", async () => {
  let releaseTransport;
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: () =>
      new Promise((_resolve, reject) => {
        releaseTransport = () => reject(new Error("still draining"));
      }),
  });
  const pending = io.call("https://pds.example/xrpc/a", {
    expect: "status",
  });
  const order = [];
  const closing = io.close({ settleTimeoutMs: 1_000 }).then(() => {
    order.push("close resolved");
  });
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  order.push("close still waiting");
  releaseTransport();
  await assert.rejects(pending);
  await closing;
  assert.deepEqual(order, ["close still waiting", "close resolved"]);
});

test("teardown settles within its budget when the transport ignores abort", async () => {
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: () => new Promise(() => {}),
  });
  const ignored = io.call("https://pds.example/xrpc/a", {
    expect: "status",
  });
  const started = Date.now();
  const outcome = await within(io.close({ settleTimeoutMs: 60 }), 1_000);
  assert.equal(outcome.value, undefined, "Bounded teardown completes");
  assert.ok(Date.now() - started < 1_000, "Cleanup wait is bounded");
  await assert.rejects(ignored, { name: "AbortError" });
});

test("an external test abort settles and cleans up the call", async () => {
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: () => new Promise(() => {}),
  });
  const controller = new AbortController();
  const pending = io.call("https://pds.example/xrpc/a", {
    expect: "json",
    signal: controller.signal,
  });
  controller.abort(new Error("test aborted"));
  const outcome = await within(pending, 1_000);
  assert.equal(outcome.error?.message, "test aborted");
  await io.close();
});

test("a pre-aborted external signal never dispatches", async () => {
  let calls = 0;
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    io.call("https://pds.example/xrpc/a", {
      signal: controller.signal,
    }),
  );
  assert.equal(calls, 0, "Aborted work must not reach the transport");
  await io.close();
});

test("a streamed request body is dispatched with its duplex requirement met", async () => {
  const seen = [];
  let reads = 0;
  const body = new ReadableStream({
    pull(controller) {
      reads += 1;
      controller.enqueue(new Uint8Array([reads]));
      if (reads >= 2) controller.close();
    },
  });
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: async (url, init) => {
      const request = new Request(url, init);
      seen.push({ method: request.method, duplex: init.duplex });
      const received = new Uint8Array(await request.arrayBuffer());
      return jsonResponse({ received: received.byteLength });
    },
  });
  const result = await io.call("https://pds.example/xrpc/a", {
    bytes: body,
    expect: "json",
  });
  assert.equal(result.received, 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].duplex, "half", "A stream body needs duplex half");
  await io.close();
});

test("a streamed request body keeps its own content type", async () => {
  const seen = [];
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: async (url, init) => {
      const request = new Request(url, init);
      seen.push({
        duplex: init.duplex,
        contentType: init.headers["content-type"],
        length: (await request.arrayBuffer()).byteLength,
      });
      return jsonResponse({ ok: true });
    },
  });
  await io.call("https://pds.example/xrpc/a", {
    bytes: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
    headers: { "content-type": "application/vnd.ipld.car" },
  });
  assert.deepEqual(seen, [
    { duplex: "half", contentType: "application/vnd.ipld.car", length: 3 },
  ]);
  await io.close();
});

test("a non-stream body is dispatched without duplex", async () => {
  const seen = [];
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: async (_url, init) => {
      seen.push({ duplex: init.duplex, body: init.body });
      return jsonResponse({ ok: true });
    },
  });
  await io.call("https://pds.example/xrpc/a", { bytes: new Uint8Array([1]) });
  assert.deepEqual(seen, [{ duplex: undefined, body: new Uint8Array([1]) }]);
  await io.close();
});

test("a prefix outside readiness failures never starts its stream", async () => {
  const cases = [
    [
      "non-2xx",
      { status: 500, ok: false },
      (error) => error instanceof ResponseStatusError && error.status === 500,
    ],
    [
      "malformed declared length",
      { headers: new Headers({ "content-length": "not-a-number" }) },
      (error) =>
        error instanceof ResponseBodyError &&
        error.message === "Malformed response content length",
    ],
    [
      "declared over the limit",
      { headers: new Headers({ "content-length": "9" }) },
      (error) =>
        error instanceof ResponseBodyError &&
        error.message === "Response exceeds CAR limit",
    ],
    [
      "omitted body",
      { omitBody: true },
      (error) =>
        error instanceof ResponseBodyError &&
        error.message === "Response omitted body",
    ],
  ];
  for (const [name, shape, matches] of cases) {
    const { response, state } = guardedStreamResponse({
      ready: { cancel: true },
    });
    const candidate = {
      ...response,
      ...shape,
      headers:
        shape.headers ??
        new Headers({ "content-type": "application/vnd.ipld.car" }),
    };
    if (shape.omitBody) candidate.body = undefined;
    const io = createIncomingPublicIo({
      timeoutMs: 5_000,
      carLimitBytes: 8,
      fetch: async () => candidate,
    });
    const outcome = await within(
      io.call("https://pds.example/xrpc/a", { expect: "car" }),
      1_000,
    );
    assert.ok(matches(outcome.error), `${name}: expected a typed rejection`);
    assert.equal(
      state.cancelled,
      name === "omitted body" ? false : true,
      `${name}: an unread body must be released without starting it`,
    );
    await io.close();
  }
});

test("a network TypeError is reported, not absorbed", async () => {
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const outcome = await within(
    io.call("https://pds.example/xrpc/a", { expect: "car" }),
    1_000,
  );
  assert.ok(outcome.error instanceof TypeError);
  assert.equal(outcome.error.message, "fetch failed");
  await io.close();
});

test("a non-2xx CAR rejection is not a body-limit diagnosis", async () => {
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: async () =>
      new Response(new Uint8Array([1]), {
        status: 404,
        headers: { "content-type": "application/vnd.ipld.car" },
      }),
  });
  const outcome = await within(
    io.call("https://pds.example/xrpc/a", { expect: "car" }),
    1_000,
  );
  assert.ok(outcome.error instanceof ResponseStatusError);
  assert.equal(outcome.error.status, 404);
  await io.close();
});

test("a phase timeout reports its own reason, not a body error", async () => {
  const io = createIncomingPublicIo({
    timeoutMs: 30,
    fetch: async () => {
      const { response } = guardedStreamResponse();
      response.body.getReader = () => ({
        read: () => new Promise(() => {}),
        cancel: () => Promise.resolve(),
      });
      return response;
    },
  });
  const outcome = await within(
    io.call("https://pds.example/xrpc/a", { expect: "car" }),
    1_000,
  );
  assert.ok(outcome.error instanceof Error);
  assert.equal(
    outcome.error instanceof ResponseBodyError,
    false,
    "A timeout must not masquerade as a body diagnosis",
  );
  assert.equal(outcome.error instanceof ResponseStatusError, false);
  await io.close();
});

test("oversized declared CAR rejects before reading the body", async () => {
  let reads = 0;
  let cancelled = false;
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    carLimitBytes: 8,
    fetch: async () => ({
      status: 200,
      ok: true,
      headers: new Headers({
        "content-type": "application/vnd.ipld.car",
        "content-length": "16",
      }),
      body: {
        getReader: () => ({
          read: () => {
            reads += 1;
            return Promise.resolve({ done: true, value: undefined });
          },
          cancel: () => {
            cancelled = true;
            return Promise.resolve();
          },
        }),
        cancel: () => {
          cancelled = true;
          return Promise.resolve();
        },
      },
    }),
  });
  const outcome = await within(
    io.call("https://pds.example/xrpc/a", { expect: "car" }),
    1_000,
  );
  assert.equal(outcome.error?.message, "Response exceeds CAR limit");
  assert.equal(reads, 0, "No body chunk may be read to decide the bound");
  assert.equal(cancelled, true, "The unread body is released");
  await io.close();
});

test("undeclared oversized CAR rejects without retaining excess", async () => {
  let reads = 0;
  let cancelled = false;
  const chunk = new Uint8Array(6);
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    carLimitBytes: 8,
    fetch: async () => ({
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "application/vnd.ipld.car" }),
      body: {
        getReader: () => ({
          read: () => {
            reads += 1;
            return Promise.resolve({ done: false, value: chunk });
          },
          cancel: () => {
            cancelled = true;
            return Promise.resolve();
          },
        }),
        cancel: () => Promise.resolve(),
      },
    }),
  });
  const outcome = await within(
    io.call("https://pds.example/xrpc/a", { expect: "car" }),
    1_000,
  );
  assert.equal(outcome.error?.message, "Response exceeds CAR limit");
  assert.equal(reads, 2, "The overrun chunk is detected, not aggregated");
  assert.equal(cancelled, true, "The overrun reader is released");
  await io.close();
});

test("a CAR exactly at the limit succeeds", async () => {
  const chunk = new Uint8Array(6);
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    carLimitBytes: 8,
    fetch: async () => carResponse([chunk, new Uint8Array(2)]),
  });
  const bytes = await io.call("https://pds.example/xrpc/a", {
    expect: "car",
  });
  assert.equal(bytes.byteLength, 8);
  await io.close();
});

test("a limit of one byte accepts exactly one byte", async () => {
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    carLimitBytes: 1,
    fetch: async () => carResponse([new Uint8Array(1)]),
  });
  const bytes = await io.call("https://pds.example/xrpc/a", {
    expect: "car",
  });
  assert.deepEqual([...bytes], [0]);
  await io.close();
});

test("malformed declared CAR length rejects", async () => {
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    carLimitBytes: 8,
    fetch: async () =>
      carResponse([new Uint8Array(1)], { declared: "not-a-number" }),
  });
  const outcome = await within(
    io.call("https://pds.example/xrpc/a", { expect: "car" }),
    1_000,
  );
  assert.equal(outcome.error?.message, "Malformed response content length");
  await io.close();
});

test("request bodies and headers are composed without escaping", async () => {
  const seen = [];
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: async (url, init) => {
      seen.push({ url, init });
      return jsonResponse({ ok: true });
    },
  });
  await io.call("https://pds.example/xrpc/a", {
    verb: "POST",
    token: "token-value",
    json: { did: "did:plc:example" },
  });
  await io.call("https://pds.example/xrpc/b", {
    verb: "POST",
    token: "token-value",
    bytes: new Uint8Array([1]),
    headers: { "content-type": "image/png" },
    expect: "text",
  });
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers.authorization, "Bearer token-value");
  assert.equal(seen[0].init.headers["content-type"], "application/json");
  assert.equal(seen[0].init.body, JSON.stringify({ did: "did:plc:example" }));
  assert.equal(seen[1].init.headers["content-type"], "image/png");
  assert.deepEqual([...seen[1].init.body], [1]);
  await io.close();
});

test("non-JSON, failed and malformed bodies reject", async () => {
  const cases = [
    [
      "unexpected content type",
      () => new Response("text", { status: 200 }),
      "Unexpected response content type",
    ],
    [
      "unexpected status",
      () => jsonResponse({ error: "InvalidRequest" }, 400),
      "Unexpected response status",
    ],
    [
      "malformed body",
      () =>
        new Response(new Uint8Array([0xff]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      "Malformed response body",
    ],
  ];
  for (const [name, respond, message] of cases) {
    const io = createIncomingPublicIo({
      timeoutMs: 5_000,
      fetch: async () => respond(),
    });
    const outcome = await within(
      io.call("https://pds.example/xrpc/a", { expect: "json" }),
      1_000,
    );
    assert.equal(outcome.error?.message, message, name);
    await io.close();
  }
});

test("a failed response exposes its machine error code", async () => {
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: async () =>
      jsonResponse(
        { error: "AccountDeactivated", message: "deactivated" },
        401,
      ),
  });
  const outcome = await within(io.call("https://pds.example/xrpc/a"), 1_000);
  assert.equal(outcome.error.status, 401);
  assert.equal(outcome.error.body.error, "AccountDeactivated");
  await io.close();
});

test("status consumption reports the code synchronously", async () => {
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: async () => new Response(null, { status: 204 }),
  });
  assert.equal(
    await io.call("https://pds.example/xrpc/a", { expect: "status" }),
    204,
  );
  await io.close();
});

test("an empty successful body decodes to no value", async () => {
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: async () => new Response(null, { status: 200 }),
  });
  assert.equal(await io.call("https://pds.example/xrpc/a"), undefined);
  assert.equal(
    await io.call("https://pds.example/xrpc/a", { expect: "text" }),
    "",
  );
  await io.close();
});

test("a closed client refuses further work", async () => {
  const io = createIncomingPublicIo({
    timeoutMs: 5_000,
    fetch: async () => jsonResponse({}),
  });
  await io.close();
  await assert.rejects(io.call("https://pds.example/xrpc/a"), {
    message: "Incoming public I/O is closed",
  });
});

test("invalid construction is refused", () => {
  assert.throws(() => createIncomingPublicIo({ fetch: 1 }), TypeError);
  assert.throws(() => createIncomingPublicIo({ timeoutMs: 0 }), RangeError);
  assert.throws(() => createIncomingPublicIo({ carLimitBytes: 0 }), RangeError);
});

const createHeldStream = (body) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const sent = new Promise((resolve) => {
    started = resolve;
  });
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(body.subarray(0, body.length - 1));
      started();
      await gate;
      try {
        controller.enqueue(body.subarray(body.length - 1));
        controller.close();
      } catch {
        release();
      }
    },
    cancel() {
      release();
    },
  });
  return { stream, sent, release };
};

const heldSeam = (fetch, options = {}) => {
  const io = createIncomingPublicIo({ timeoutMs: 5_000, fetch });
  const heldStreams = [];
  const run = (url, runOptions = {}) => {
    const held = runHeldStreamedCall(io, url, {
      ...options,
      ...runOptions,
    });
    heldStreams.push(held);
    return held;
  };
  return {
    run,
    close: async () => {
      for (const held of heldStreams) await held.retireNow();
      await io.close();
    },
  };
};

test("a released held stream reports success only with its empty text body", async () => {
  const body = new Uint8Array([1, 2, 3, 4]);
  const { stream, sent, release } = createHeldStream(body);
  const { run, close } = heldSeam(
    async () => new Response(null, { status: 200 }),
    { deadlineMs: 5_000 },
  );
  const held = run("https://pds.example/xrpc/import", {
    bytes: stream,
    expect: "text",
  });
  await sent;
  release();
  const settled = await within(held.tagged, 1_000);
  assert.equal(settled.value.outcome, "success");
  assert.equal(
    await held.consume({ expect: "text" }),
    "",
    "Only the empty text body attests this stream's success",
  );
  await close();
});

test("a consumed held stream rethrows the original HTTP failure", async () => {
  const body = new Uint8Array([1, 2, 3, 4]);
  const { stream, sent } = createHeldStream(body);
  const { run, close } = heldSeam(
    async () =>
      new Response(new TextEncoder().encode('{"error":"InvalidRequest"}'), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    { deadlineMs: 5_000 },
  );
  const held = run("https://pds.example/xrpc/import", {
    bytes: stream,
    expect: "text",
  });
  await sent;
  const settled = await within(held.tagged, 1_000);
  assert.equal(settled.value.outcome, "failure");
  await assert.rejects(held.consume({ expect: "text" }), (error) => {
    assert.ok(error instanceof ResponseStatusError);
    assert.equal(error.status, 400);
    return true;
  });
  await close();
});

test("a consumed held stream rethrows the original transport failure", async () => {
  const body = new Uint8Array([1, 2, 3, 4]);
  const { stream, sent } = createHeldStream(body);
  const failure = new TypeError("fetch failed");
  const { run, close } = heldSeam(
    async () => {
      throw failure;
    },
    { deadlineMs: 5_000 },
  );
  const held = run("https://pds.example/xrpc/import", {
    bytes: stream,
    expect: "text",
  });
  await sent;
  const settled = await within(held.tagged, 1_000);
  assert.equal(settled.value.outcome, "failure");
  assert.equal(
    settled.value.error,
    failure,
    "The exact transport failure instance must surface, not a wrapper",
  );
  await assert.rejects(
    held.consume({ expect: "text" }),
    (error) => error === failure,
  );
  await close();
});

test("a held stream still delivers its deadline abort as the original failure", async () => {
  const body = new Uint8Array([1, 2, 3, 4]);
  const { stream } = createHeldStream(body);
  const { run, close } = heldSeam(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      }),
    { deadlineMs: 30 },
  );
  const held = run("https://pds.example/xrpc/import", {
    bytes: stream,
    expect: "text",
  });
  const settled = await within(held.tagged, 1_000);
  assert.equal(settled.value.outcome, "failure");
  assert.equal(
    settled.value.error?.message,
    "Held stream deadline exhausted",
    "A deadline abort must reject with its own reason even if the stream never completes",
  );
  await close();
});

test("a held stream failure tags its settlement without an unhandled rejection", async () => {
  const body = new Uint8Array([1, 2, 3, 4]);
  const { stream } = createHeldStream(body);
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const { run, close } = heldSeam(
    async () => new Response(null, { status: 500 }),
    { deadlineMs: 30 },
  );
  const held = run("https://pds.example/xrpc/import", {
    bytes: stream,
    expect: "text",
  });
  const settled = await within(held.tagged, 1_000);
  assert.equal(
    settled.value.outcome,
    "failure",
    "The settlement is attached early and tagged as a failure",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(
    unhandled,
    [],
    "An unread held failure must not surface as an unhandled rejection",
  );
  await close();
});

test("an inventory check is retained beside, never instead of, stream success", async () => {
  const body = new Uint8Array([1, 2, 3, 4]);
  const { stream, release } = createHeldStream(body);
  const { run, close } = heldSeam(
    async () => new Response(null, { status: 200 }),
    { deadlineMs: 5_000 },
  );
  const held = run("https://pds.example/xrpc/import", {
    bytes: stream,
    expect: "text",
  });
  release();
  assert.equal(await held.consume({ expect: "text" }), "");
  assert.equal(
    (await held.tagged).outcome,
    "success",
    "Inventory equality is a separate observation; only the empty body attests this stream's success",
  );
  await close();
});
