import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
const address = process.env.REGISTRY_TEST_GATEWAY_IP;
if (!address || !isIP(address)) throw new Error("InvalidSandboxGateway");
const config = JSON.parse(await readFile("/config/config.json", "utf8"));
const pdsConfig = structuredClone(config);
for (const host of pdsConfig.pds) {
  if (
    typeof host.callbackToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(host.callbackToken) ||
    host.callbackToken === pdsConfig.adminPassword ||
    pdsConfig.pds.some(
      (other) =>
        host.callbackToken === other.adminPassword ||
        (other !== host && host.callbackToken === other.callbackToken),
    )
  )
    host.callbackToken = randomBytes(32).toString("base64url");
}
const pds = pdsConfig.pds.find((item) => item.id === "pds1");
if (!pds) throw new Error("MissingSandboxPds");
pds.adminPassword = randomBytes(32).toString("base64url");
if (pds.callbackToken === pds.adminPassword)
  pds.callbackToken = randomBytes(32).toString("base64url");
config.pds = [];
const keyId = "sandbox";
const keyring = {
  activeKeyId: keyId,
  keys: { [keyId]: randomBytes(32).toString("base64") },
};
const {
  issuer,
  serviceDid,
  jwtPublicHex,
  plcRotationKeyDid,
  handleDomains,
  plcUrl,
} = pdsConfig;
const pdsRuntime = {
  issuer,
  serviceDid,
  jwtPublicHex,
  plcRotationKeyDid,
  handleDomains,
  plcUrl,
  pds: [pds],
};
await writeFile("/pds1-config/outbound-pds1.json", JSON.stringify(pdsRuntime), {
  mode: 0o600,
});
const origin = new URL(pds.url).origin;
const second = pdsConfig.pds.find((item) => item.id === "pds2");
if (!second) throw new Error("MissingSecondSandboxPds");
const secondOrigin = new URL(second.url).origin;
for (const [name, contents] of Object.entries({
  "bootstrap.json": config,
  "health-contacts.json": {
    fleet: `fleet-${randomBytes(8).toString("hex")}@example.test`,
    hosts: {
      "pds-monitor": `pds-${randomBytes(8).toString("hex")}@example.test`,
    },
  },
  "outbound-pds1.json": pdsConfig,
  "registry-keyring.json": keyring,
  "registry-targets.json": { [origin]: [address], [secondOrigin]: [address] },
  "registry-targets-other.json": { [origin]: ["127.0.0.2"] },
}))
  await writeFile(`/config/${name}`, JSON.stringify(contents), { mode: 0o600 });
