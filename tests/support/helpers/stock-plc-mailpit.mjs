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
  const origin = new URL(baseUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password)
    throw new Error("Mailpit requires HTTPS without credentials");
  const endpoint = new URL("/api/v1/search", origin);
  endpoint.searchParams.set("query", `to:${recipient}`);
  endpoint.searchParams.set("limit", "50");
  const deadline = Date.now() + timeoutMs;
  const hasRecipient = (message) =>
    Array.isArray(message.To) &&
    message.To.some(
      (item) => item.Address?.toLowerCase() === recipient.toLowerCase(),
    );
  const read = async (url) => {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(5000, deadline - Date.now())),
      ),
    });
    if (!response.ok) throw new Error("Mailpit request failed");
    return response.json();
  };
  while (Date.now() < deadline) {
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
    if (candidates.length > 1) throw new Error("Ambiguous stock PLC messages");
    if (candidates.length === 1) {
      const message = candidates[0];
      const detail = await read(
        new URL(`/api/v1/message/${encodeURIComponent(message.ID)}`, origin),
      );
      if (!hasRecipient(detail) || detail.ID !== message.ID)
        throw new Error("Invalid Mailpit message boundary");
      return { token: parseStockPlcMessage(detail), messageId: message.ID };
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))),
    );
  }
  throw new Error("Timed out waiting for stock PLC message");
}
