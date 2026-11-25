import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
const address = process.env.REGISTRY_TEST_GATEWAY_IP;
if (!address || !isIP(address)) throw new Error("InvalidSandboxGateway");
const config = JSON.parse(await readFile("/config/config.json", "utf8"));
const pdsConfig = structuredClone(config);
const pds = pdsConfig.pds.find((item) => item.id === "pds1");
if (!pds) throw new Error("MissingSandboxPds");
pds.adminPassword = randomBytes(32).toString("base64url");
config.pds = [];
const keyId = "sandbox";
const keyring = {
  activeKeyId: keyId,
  keys: { [keyId]: randomBytes(32).toString("base64") },
};
const origin = new URL(pds.url).origin;
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
  "registry-targets.json": { [origin]: [address] },
  "registry-targets-other.json": { [origin]: ["127.0.0.2"] },
}))
  await writeFile(`/config/${name}`, JSON.stringify(contents), { mode: 0o600 });
