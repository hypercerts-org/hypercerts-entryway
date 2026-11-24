import assert from "node:assert/strict";
import test from "node:test";
import { NoMailpitMessageError, waitForMailpitCode } from "./mailpit.mjs";

const options = {
  baseUrl: "https://mailpit.example",
  recipient: "recipient@example.test",
  since: 0,
  timeoutMs: 100,
};
const message = {
  ID: "matching-message",
  To: [{ Address: options.recipient }],
  Created: new Date(0).toISOString(),
};

test("a successfully searched empty mailbox yields the no-message result", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const search = t.mock.method(globalThis, "fetch", async () => {
    t.mock.timers.tick(options.timeoutMs);
    return Response.json({ messages: [] });
  });
  await assert.rejects(waitForMailpitCode(options), NoMailpitMessageError);
  assert.equal(search.mock.callCount(), 1);
});

for (const stalledRequest of ["search", "detail"]) {
  test(`a Mailpit ${stalledRequest} timeout at the deadline propagates`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    const failure = new DOMException("Timed out", "TimeoutError");
    t.mock.method(globalThis, "fetch", async (url) => {
      if (stalledRequest === "detail" && url.pathname === "/api/v1/search")
        return Response.json({ messages: [message] });
      t.mock.timers.tick(options.timeoutMs);
      throw failure;
    });
    await assert.rejects(
      waitForMailpitCode(options),
      (error) => error === failure,
    );
  });
}

test("mail without a verification code cannot establish an empty mailbox", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.pathname === "/api/v1/search")
      return Response.json({ messages: [message] });
    t.mock.timers.tick(options.timeoutMs);
    return Response.json({ ...message, Text: "No code in this message" });
  });
  await assert.rejects(
    waitForMailpitCode(options),
    /without a verification code/,
  );
});
