import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
const config = JSON.parse(await readFile("/config/bootstrap.json", "utf8"));
assert.equal(new URL(config.issuer).protocol, "https:");
const source = JSON.parse(await readFile("/config/outbound-pds1.json", "utf8"));
const host = source.pds.find((item) => item.id === "pds1");
const auth = `Basic ${Buffer.from(`admin:${config.adminPassword}`).toString("base64")}`;
const request = async (node, path, body, authenticated = true) => {
  const response = await fetch(new URL(path, config.issuer), {
    method: body ? "POST" : "GET",
    headers: {
      "x-bootstrap-node": node,
      ...(authenticated ? { authorization: auth } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
};
for (const node of ["bootstrap-a", "bootstrap-b"]) {
  assert.equal((await request(node, "/_health")).status, 200);
  assert.equal((await request(node, "/_readyz")).status, 200);
  assert.equal(
    (await request(node, "/admin/pds-registry/status", undefined, false))
      .status,
    401,
  );
  for (const path of [
    "/",
    "/login",
    "/xrpc/com.atproto.server.createAccount",
    "/.well-known/did.json",
  ])
    assert.equal((await request(node, path)).status, 404);
}
const id = `two-node-${randomBytes(8).toString("hex")}`;
const base = `/admin/pds-registry/hosts/${id}`;
const staged = await request("bootstrap-a", "/admin/pds-registry/hosts", {
  host: {
    hostId: id,
    serviceDid: host.did,
    publicUrl: host.url,
    internalUrl: host.url,
    order: 1,
  },
  credentials: {
    outboundPassword: host.adminPassword,
    inboundToken: randomBytes(32).toString("base64url"),
  },
  expectedRevision: 0,
  idempotencyKey: randomBytes(16).toString("hex"),
});
assert.equal(staged.status, 200);
const checked = await request("bootstrap-a", `${base}/check`, {
  expectedRevision: 1,
});
assert.equal(checked.status, 200);
assert.equal(checked.body.outbound.last.reason, "ok");
const a = (await request("bootstrap-a", `${base}/policy`)).body;
const b = (await request("bootstrap-b", `${base}/policy`)).body;
assert.notEqual(a.intended.fingerprint, b.intended.fingerprint);
assert.equal(
  (await request("bootstrap-b", `${base}/check`, { expectedRevision: 1 }))
    .status,
  409,
);
assert.equal(
  (
    await request("bootstrap-b", `${base}/policy`, {
      revision: 1,
      expectedGeneration: 1,
      fingerprint: b.intended.fingerprint,
    })
  ).body.policy.generation,
  2,
);
assert.equal(
  (await request("bootstrap-a", `${base}/check`, { expectedRevision: 1 }))
    .status,
  409,
);
assert.equal(
  (
    await request("bootstrap-a", `${base}/policy`, {
      revision: 1,
      expectedGeneration: 2,
      fingerprint: a.intended.fingerprint,
    })
  ).body.policy.generation,
  3,
);
const after = await request("bootstrap-a", base);
assert.equal(after.body.outbound.last, null);
assert.equal(after.body.inbound, "unproven");
assert.equal(after.body.host.lifecycle, "disabled");
assert.equal(after.body.host.activeRevision, null);
console.log(
  "two bootstrap processes: admin isolation, divergent policies and rollback fencing passed",
);
