import test from "node:test";
import assert from "node:assert/strict";
import {
  parseStockPlcMessage,
  waitForStockPlcMessage,
} from "./stock-plc-mailpit.mjs";

const phrase =
  "We received a request to update your PLC identity. Your confirmation code is:";
const message = {
  Subject: "PLC Update Operation Requested",
  Text: `${phrase}\nABCDE-FG234`,
  HTML: `<p>${phrase}</p><code>ABCDE-FG234</code>`,
};

test("parses stock PLC text and HTML and rejects mismatched content", () => {
  assert.equal(parseStockPlcMessage(message), "ABCDE-FG234");
  assert.equal(parseStockPlcMessage({ ...message, HTML: "" }), "ABCDE-FG234");
  assert.equal(parseStockPlcMessage({ ...message, Text: "" }), "ABCDE-FG234");
  for (const bad of [
    { ...message, Subject: "Other" },
    { ...message, Text: "Use 12345678 to login", HTML: "" },
    { ...message, Text: `${message.Text} ${message.Text}` },
    { ...message, HTML: message.HTML.replace("ABCDE", "ZZZZZ") },
    { ...message, Text: "", HTML: "" },
  ])
    assert.throws(() => parseStockPlcMessage(bad));
});

test("poll binds recipient, time and excluded IDs", async () => {
  let fetchImpl;
  const since = Date.now() - 1000;
  const candidate = {
    Subject: message.Subject,
    ID: "new",
    To: [{ Address: "user@example.com" }],
    Created: new Date().toISOString(),
  };
  const detail = {
    ...message,
    ID: candidate.ID,
    To: candidate.To,
    Date: new Date(since - 60_000).toISOString(),
  };
  {
    fetchImpl = async (url) =>
      Response.json(
        String(url).includes("/search")
          ? {
              messages: [
                { ...candidate, ID: "excluded" },
                {
                  ...candidate,
                  ID: "old",
                  Created: new Date(since - 1).toISOString(),
                },
                {
                  ...candidate,
                  ID: "wrong",
                  To: [{ Address: "other@example.com" }],
                },
                candidate,
              ],
            }
          : detail,
      );
    const result = await waitForStockPlcMessage({
      recipient: "user@example.com",
      since,
      excludeIds: ["excluded"],
      baseUrl: "https://mail.example",
      fetch: (...args) => fetchImpl(...args),
      timeoutMs: 1000,
    });
    assert.equal(result.messageId, "new");
    const options = {
      recipient: "user@example.com",
      since,
      excludeIds: [],
      baseUrl: "https://mail.example",
      fetch: (...args) => fetchImpl(...args),
      timeoutMs: 50,
    };
    for (const created of [
      undefined,
      "invalid",
      new Date(since - 1).toISOString(),
    ]) {
      fetchImpl = async () =>
        Response.json({ messages: [{ ...candidate, Created: created }] });
      await assert.rejects(waitForStockPlcMessage(options), /Timed out/);
    }
    for (const badDetail of [
      { ...detail, ID: "other" },
      { ...detail, To: [{ Address: "other@example.com" }] },
      { ...detail, Subject: "Other" },
    ]) {
      fetchImpl = async (url) =>
        Response.json(
          String(url).includes("/search")
            ? { messages: [candidate] }
            : badDetail,
        );
      await assert.rejects(waitForStockPlcMessage(options));
    }
    fetchImpl = async () =>
      Response.json({
        messages: [candidate, { ...candidate, ID: "another" }],
      });
    await assert.rejects(
      waitForStockPlcMessage({
        recipient: "user@example.com",
        since,
        excludeIds: [],
        baseUrl: "https://mail.example",
        fetch: (...args) => fetchImpl(...args),
        timeoutMs: 1000,
      }),
      /Ambiguous/,
    );
    await assert.rejects(
      waitForStockPlcMessage({
        recipient: "user@example.com",
        since,
        excludeIds: [],
        baseUrl: "http://mail.example",
        fetch: (...args) => fetchImpl(...args),
        timeoutMs: 1000,
      }),
      /HTTPS/,
    );
  }
});

const pollOptions = {
  recipient: "user@example.com",
  since: Date.now() - 1000,
  excludeIds: [],
  baseUrl: "https://mail.example",
  timeoutMs: 1000,
  intervalMs: 1,
};

test("poll rejects redirects at search and detail without following HTTP downgrades", async () => {
  const candidate = {
    ...message,
    ID: "matching",
    To: [{ Address: pollOptions.recipient }],
    Created: new Date().toISOString(),
  };
  for (const redirectAt of ["search", "detail"]) {
    const requests = [];
    const failure = new TypeError("unexpected redirect");
    await assert.rejects(
      waitForStockPlcMessage({
        ...pollOptions,
        fetch: async (url, init) => {
          const request = new Request(url, init);
          requests.push(request);
          const phase = request.url.includes("/search") ? "search" : "detail";
          if (phase === redirectAt) {
            const response = Response.redirect("http://mail.example/downgrade");
            if (request.redirect === "error") throw failure;
            requests.push(new Request(response.headers.get("location")));
            return Response.json(
              phase === "search" ? { messages: [candidate] } : candidate,
            );
          }
          return Response.json({ messages: [candidate] });
        },
      }),
      (error) => error === failure,
    );
    assert.equal(requests.length, redirectAt === "search" ? 1 : 2);
    for (const request of requests) {
      assert.equal(new URL(request.url).protocol, "https:");
      assert.equal(request.redirect, "error");
    }
  }
});

test("poll accepts direct HTTPS search and detail with redirects disabled", async () => {
  const candidate = {
    ...message,
    ID: "matching",
    To: [{ Address: pollOptions.recipient }],
    Created: new Date().toISOString(),
  };
  const requests = [];
  const result = await waitForStockPlcMessage({
    ...pollOptions,
    fetch: async (url, init) => {
      const request = new Request(url, init);
      requests.push(request);
      return Response.json(
        request.url.includes("/search") ? { messages: [candidate] } : candidate,
      );
    },
  });
  assert.deepEqual(result, { token: "ABCDE-FG234", messageId: "matching" });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(new URL(request.url).protocol, "https:");
    assert.equal(request.method, "GET");
    assert.equal(request.redirect, "error");
  }
});

test("poll cancellation reaches the injected transport and settles", async () => {
  const controller = new AbortController();
  let requestSignal;
  const pending = waitForStockPlcMessage({
    ...pollOptions,
    signal: controller.signal,
    fetch: async (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  const reason = new Error("poll cancelled");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(requestSignal.aborted, true);
});

test("poll deadline bounds held response bodies and cancels the reader", async () => {
  let cancelled = false;
  await assert.rejects(
    waitForStockPlcMessage({
      ...pollOptions,
      timeoutMs: 30,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    }),
    /Timed out/,
  );
  assert.equal(cancelled, true);
});

test("poll rejects malformed matching content, invalid search and oversized bodies", async () => {
  const candidate = {
    ...message,
    ID: "matching",
    To: [{ Address: pollOptions.recipient }],
    Created: new Date().toISOString(),
  };
  for (const detail of [
    { ...candidate, Text: "unrelated code", HTML: "" },
    { ...candidate, Text: null, HTML: 42 },
    { ...candidate, ID: "changed" },
    { ...candidate, To: [] },
    { ...candidate, Subject: "login" },
  ]) {
    await assert.rejects(
      waitForStockPlcMessage({
        ...pollOptions,
        fetch: async (url) =>
          Response.json(
            String(url).includes("/search")
              ? { messages: [candidate] }
              : detail,
          ),
      }),
    );
  }
  for (const value of [null, {}, { messages: null }]) {
    await assert.rejects(
      waitForStockPlcMessage({
        ...pollOptions,
        fetch: async () => Response.json(value),
      }),
    );
  }
  await assert.rejects(
    waitForStockPlcMessage({
      ...pollOptions,
      fetch: async () => new Response("x".repeat(1024 * 1024 + 1)),
    }),
    /limit/,
  );
  await assert.rejects(
    waitForStockPlcMessage({
      ...pollOptions,
      fetch: async () => new Response("{broken"),
    }),
    SyntaxError,
  );
});

test("poll remains sequential and cancellation interrupts the retry delay", async () => {
  const controller = new AbortController();
  let active = 0;
  let calls = 0;
  const pending = waitForStockPlcMessage({
    ...pollOptions,
    intervalMs: 1000,
    signal: controller.signal,
    fetch: async () => {
      calls++;
      assert.equal(++active, 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      setTimeout(() => controller.abort(new Error("stop delay")), 5);
      return Response.json({ messages: [] });
    },
  });
  await assert.rejects(pending, /stop delay/);
  assert.equal(calls, 1);
});
