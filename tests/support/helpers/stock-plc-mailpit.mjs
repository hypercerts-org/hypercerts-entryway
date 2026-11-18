import { setTimeout as delay } from "node:timers/promises";
import { createIncomingPublicIo } from "./incoming-public-io.mjs";

const subject = "PLC Update Operation Requested";
const phrase =
  "We received a request to update your PLC identity. Your confirmation code is:";

export function parseStockPlcMessage(message) {
  if (message?.Subject !== subject) throw new Error("Not a stock PLC message");
  const tokens = [];
  if (message.Text) {
    const text = message.Text.replace(/\s+/g, " ");
    const matches = [
      ...text.matchAll(
        /We received a request to update your PLC identity\. Your confirmation code is:\s*([A-Z2-7]{5}-[A-Z2-7]{5})\b/g,
      ),
    ];
    if (matches.length !== 1) throw new Error("Malformed stock PLC text");
    tokens.push(matches[0][1]);
  }
  if (message.HTML) {
    const html = message.HTML.replace(/\s+/g, " ");
    const matches = [
      ...html.matchAll(
        /We received a request to update your PLC identity\. Your confirmation code is:<\/p>\s*<code\b[^>]*>\s*([A-Z2-7]{5}-[A-Z2-7]{5})\s*<\/code>/g,
      ),
    ];
    if (matches.length !== 1 || !html.includes(phrase))
      throw new Error("Malformed stock PLC HTML");
    tokens.push(matches[0][1]);
  }
  if (!tokens.length || new Set(tokens).size !== 1)
    throw new Error("Ambiguous stock PLC message");
  return tokens[0];
}

export async function waitForStockPlcMessage({
  recipient,
  since,
  excludeIds,
  baseUrl,
  timeoutMs = 20_000,
  fetch: fetchImpl = globalThis.fetch,
  signal,
  intervalMs = 250,
}) {
  if (typeof recipient !== "string" || !/^[^\s@]+@[^\s@]+$/.test(recipient))
    throw new TypeError("Invalid recipient");
  if (
    !Number.isFinite(since) ||
    !Array.isArray(excludeIds) ||
    excludeIds.some((id) => typeof id !== "string" || !id)
  )
    throw new TypeError("Invalid message boundary");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new RangeError("Invalid timeout");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 1000)
    throw new RangeError("Invalid polling interval");
  if (typeof fetchImpl !== "function") throw new TypeError("Invalid fetch");
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new TypeError("Invalid poll signal");
  signal?.throwIfAborted();
  const origin = new URL(baseUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password)
    throw new Error("Mailpit requires HTTPS without credentials");
  const endpoint = new URL("/api/v1/search", origin);
  endpoint.searchParams.set("query", `to:${recipient}`);
  endpoint.searchParams.set("limit", "50");
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(new Error("Timed out waiting for stock PLC message")),
    timeoutMs,
  );
  const pollSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const io = createIncomingPublicIo({
    fetch: fetchImpl,
    signal: pollSignal,
    timeoutMs: Math.min(5000, timeoutMs),
    carLimitBytes: 1024 * 1024,
  });
  const hasRecipient = (message) =>
    Array.isArray(message.To) &&
    message.To.some(
      (item) => item.Address?.toLowerCase() === recipient.toLowerCase(),
    );
  // Reuse managed cancellation/settlement and bounded streaming consumption.
  // Mailpit timestamps in search are server Created times; message Date is not.
  const read = async (url) => {
    const bytes = await io.call(url.href, {
      verb: "GET",
      expect: "car",
      redirect: "error",
    });
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  };
  try {
    for (;;) {
      pollSignal.throwIfAborted();
      const result = await read(endpoint);
      if (!Array.isArray(result.messages))
        throw new Error("Invalid Mailpit response");
      const candidates = result.messages.filter(
        (message) =>
          typeof message.ID === "string" &&
          !excludeIds.includes(message.ID) &&
          hasRecipient(message) &&
          Date.parse(message.Created) >= since &&
          message.Subject === subject,
      );
      if (candidates.length > 1)
        throw new Error("Ambiguous stock PLC messages");
      if (candidates.length === 1) {
        const message = candidates[0];
        const detail = await read(
          new URL(`/api/v1/message/${encodeURIComponent(message.ID)}`, origin),
        );
        if (!hasRecipient(detail) || detail.ID !== message.ID)
          throw new Error("Invalid Mailpit message boundary");
        return { token: parseStockPlcMessage(detail), messageId: message.ID };
      }
      await delay(intervalMs, undefined, { signal: pollSignal });
    }
  } catch (error) {
    if (pollSignal.aborted) throw pollSignal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    await io.close();
  }
}
