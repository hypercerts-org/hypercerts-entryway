// Test-only preload: consume one actual unchanged-PDS response, then lose it.
// The rejected-request mode corrupts only this nominated request authorization.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
const run = process.env.MANAGED_RECOVERY_RUN;
assert.match(run ?? "", /^[a-z0-9-]+$/);
const mode = process.env.MANAGED_RECOVERY_MODE ?? "consumed-success";
assert.ok(["consumed-success", "rejected-request"].includes(mode));
const nativeFetch = globalThis.fetch;
let armed = true;
globalThis.fetch = async (url, init) => {
  const target = String(url);
  const body =
    typeof init?.body === "string" && init.body.startsWith("{")
      ? JSON.parse(init.body)
      : {};
  const match =
    armed &&
    target === "http://pds2:3000/xrpc/com.atproto.server.createAccount" &&
    body.handle === `migration-${run}.entryway.atmosbox.test`;
  if (match) armed = false;
  let request = init;
  if (match && mode === "rejected-request") {
    const headers = new Headers(init?.headers);
    headers.set("authorization", "Bearer fixture-invalid-authorization");
    request = { ...init, headers };
  }
  const response = await nativeFetch(url, request);
  if (match) {
    assert.equal(response.status, mode === "consumed-success" ? 200 : 401);
    await response.arrayBuffer();
    writeFileSync(
      `/app/artifacts/managed-recovery-${run}-response.json`,
      JSON.stringify({
        did: body.did,
        method: "com.atproto.server.createAccount",
        upstreamResponseConsumed: true,
        fault: mode,
        upstreamStatus: response.status,
      }),
    );
    throw new DOMException(
      "Injected loss after consuming target create response",
      "TimeoutError",
    );
  }
  return response;
};
