import https from "node:https";
import { isIP } from "node:net";

const MAX_RESPONSE_BYTES = 65_536;

export function getPdsJson(
  origin,
  path,
  verifier,
  authorization,
  deadlineMs = 3_000,
) {
  const url = new URL(path, origin),
    approved = verifier?.targets.get(url.origin);
  if (url.protocol !== "https:" || !approved?.length)
    return Promise.resolve({ reason: "target-not-allowed" });
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const address = isIP(hostname) ? hostname : approved[0];
  if (!approved.includes(address))
    return Promise.resolve({ reason: "target-not-allowed" });
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const request = https.request(
      url,
      {
        method: "GET",
        rejectUnauthorized: true,
        ca: verifier.ca,
        agent: false,
        autoSelectFamily: false,
        lookup: (_hostname, _options, callback) =>
          callback(null, address, isIP(address)),
        headers: {
          accept: "application/json",
          ...(authorization ? { authorization } : {}),
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          return finish({
            reason: "unexpected-status",
            status: response.statusCode,
          });
        }
        let size = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy();
            return finish({ reason: "invalid-response" });
          }
          chunks.push(chunk);
        });
        response.on("error", () => finish({ reason: "network-error" }));
        response.on("end", () => {
          try {
            finish({
              value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch {
            finish({ reason: "invalid-response" });
          }
        });
      },
    );
    request.on("error", () => finish({ reason: "network-error" }));
    timer = setTimeout(() => {
      request.destroy();
      finish({ reason: "network-error" });
    }, deadlineMs);
    request.end();
  });
}
