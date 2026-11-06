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
  const original = globalThis.fetch;
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
  try {
    globalThis.fetch = async (url) => ({
      ok: true,
      json: async () =>
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
    });
    const result = await waitForStockPlcMessage({
      recipient: "user@example.com",
      since,
      excludeIds: ["excluded"],
      baseUrl: "https://mail.example",
      timeoutMs: 1000,
    });
    assert.equal(result.messageId, "new");
    const options = {
      recipient: "user@example.com",
      since,
      excludeIds: [],
      baseUrl: "https://mail.example",
      timeoutMs: 10,
    };
    for (const created of [
      undefined,
      "invalid",
      new Date(since - 1).toISOString(),
    ]) {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ messages: [{ ...candidate, Created: created }] }),
      });
      await assert.rejects(waitForStockPlcMessage(options), /Timed out/);
    }
    for (const badDetail of [
      { ...detail, ID: "other" },
      { ...detail, To: [{ Address: "other@example.com" }] },
      { ...detail, Subject: "Other" },
    ]) {
      globalThis.fetch = async (url) => ({
        ok: true,
        json: async () =>
          String(url).includes("/search")
            ? { messages: [candidate] }
            : badDetail,
      });
      await assert.rejects(waitForStockPlcMessage(options));
    }
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        messages: [candidate, { ...candidate, ID: "another" }],
      }),
    });
    await assert.rejects(
      waitForStockPlcMessage({
        recipient: "user@example.com",
        since,
        excludeIds: [],
        baseUrl: "https://mail.example",
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
        timeoutMs: 1000,
      }),
      /HTTPS/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
