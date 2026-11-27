import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(
  await readFile(process.env.SERVICE_CONFIG_PATH, "utf8"),
);
assert.deepEqual(
  Object.keys(config).sort(),
  [
    "handleDomains",
    "issuer",
    "jwtPublicHex",
    "pds",
    "plcRotationKeyDid",
    "plcUrl",
    "serviceDid",
  ].sort(),
);
assert.equal(config.pds.length, 1);
const host = config.pds[0];
assert.equal(host.id, process.env.PDS_ID);
assert.match(host.callbackToken, /^[A-Za-z0-9_-]{43}$/);
assert.notEqual(host.callbackToken, host.adminPassword);
console.log("stock PDS configuration contains only its own credentials");
