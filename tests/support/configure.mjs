import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Secp256k1Keypair } from "@atproto/crypto";

const configPath = process.env.SERVICE_CONFIG_PATH || "/config/config.json";
let config;
const publicMode = process.env.PUBLIC_NETWORK_MODE === "true";
if (publicMode) {
  for (const key of [
    "OAUTH_ISSUER_URL",
    "OAUTH_CLIENT_URL",
    "PDS1_URL",
    "PDS2_URL",
  ]) {
    const value = process.env[key];
    if (!value)
      throw new Error(
        `${key} is required in public mode; use the launcher or its saved public.env`,
      );
    const url = new URL(value);
    if (url.protocol !== "https:" || value !== url.origin)
      throw new Error(
        `${key} must be an HTTPS origin without credentials, paths, queries, fragments, or a trailing slash`,
      );
  }
  const origins = [
    "OAUTH_ISSUER_URL",
    "OAUTH_CLIENT_URL",
    "PDS1_URL",
    "PDS2_URL",
  ].map((key) => process.env[key]);
  if (new Set(origins).size !== 4)
    throw new Error(
      "Public entryway, client, and both PDS origins must be distinct",
    );
}
await mkdir(dirname(configPath), { recursive: true });
const issuer = process.env.OAUTH_ISSUER_URL || "https://entryway.test";
const clientUrl =
  process.env.OAUTH_CLIENT_URL || "https://client.entryway.example.com";
const pdsUrls = [
  process.env.PDS1_URL || "https://pds1.entryway.test",
  process.env.PDS2_URL || "https://pds2.entryway.test",
];
const serviceDid = (url) =>
  `did:web:${new URL(url).host.replaceAll(":", "%3A")}`;
try {
  config = JSON.parse(await readFile(configPath, "utf8"));
  if (
    process.env.OAUTH_ISSUER_URL &&
    (config.issuer !== issuer ||
      config.clientUrl !== clientUrl ||
      config.pds.length !== pdsUrls.length ||
      config.pds.some((p, i) => p.url !== pdsUrls[i]))
  ) {
    throw new Error(
      "Persisted identities use different public URLs. Keep the current tunnel processes or start a fresh Compose project; do not silently rewrite live DIDs.",
    );
  }
  console.log("Reusing persisted spike identity and credentials");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const jwtJwk = { ...privateKey.export({ format: "jwk" }), alg: "ES256K" };
  const jwtKey = await Secp256k1Keypair.import(
    Buffer.from(jwtJwk.d, "base64url"),
  );
  const rotation = await Secp256k1Keypair.create({ exportable: true });
  // Qualification uses a public offline reference only. Its private material
  // is neither persisted nor mounted into the application containers.
  const offline = await Secp256k1Keypair.create();
  config = {
    version: 1,
    issuer,
    serviceDid: serviceDid(issuer),
    clientUrl,
    handleDomains: process.env.SERVICE_HANDLE_DOMAINS?.split(",") || [
      ".entryway.test",
    ],
    publicHandles: publicMode
      ? [new URL(issuer).hostname, new URL(clientUrl).hostname]
      : undefined,
    plcUrl: process.env.PLC_DIRECTORY_URL || "http://plc:2582",
    jwtJwk,
    jwtPublicHex: jwtKey.publicKeyStr("hex"),
    plcRotationKeyHex: Buffer.from(await rotation.export()).toString("hex"),
    plcRotationKeyDid: rotation.did(),
    plcRecoveryKeyDid: offline.did(),
    dpopSecret: randomBytes(32).toString("hex"),
    betterAuthSecret: randomBytes(32).toString("hex"),
    adminPassword: randomBytes(32).toString("hex"),
    pds: await Promise.all(
      ["pds1", "pds2"].map(async (id, i) => {
        const plcKey = await Secp256k1Keypair.create({ exportable: true });
        return {
          id,
          url: pdsUrls[i],
          internalUrl: `http://${id}:3000`,
          did: serviceDid(pdsUrls[i]),
          adminPassword: randomBytes(32).toString("hex"),
          jwtSecret: randomBytes(32).toString("hex"),
          plcRotationKeyHex: Buffer.from(await plcKey.export()).toString("hex"),
        };
      }),
    ),
  };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log("Generated persisted spike identity and credentials");
}

// Export only public authority metadata to the isolated source fixture. Its
// bearer token is a separate local test secret, never part of Entryway config.
if (process.env.SOURCE_FIXTURE_PUBLIC_DIR) {
  await mkdir(process.env.SOURCE_FIXTURE_PUBLIC_DIR, {
    recursive: true,
    mode: 0o755,
  });
  await writeFile(
    `${process.env.SOURCE_FIXTURE_PUBLIC_DIR}/target-rotation-key`,
    `${config.plcRotationKeyDid}\n`,
    { mode: 0o644 },
  );
}
if (process.env.SOURCE_FIXTURE_TOKEN_DIR) {
  await mkdir(process.env.SOURCE_FIXTURE_TOKEN_DIR, {
    recursive: true,
    mode: 0o700,
  });
  try {
    await writeFile(
      `${process.env.SOURCE_FIXTURE_TOKEN_DIR}/source-fixture-token`,
      `${randomBytes(32).toString("hex")}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

// The internal CA and DNS zone deliberately stay within the Compose network.
await writeFile(
  `${dirname(configPath)}/Caddyfile`,
  `{
  admin off
  persist_config off
  auto_https disable_redirects
}
https://entryway.test, https://*.entryway.test, https://client.entryway.example.com {
  tls internal
  @pds1 host pds1.entryway.test
  handle @pds1 {
    reverse_proxy pds1:3000
  }
  @pds2 host pds2.entryway.test
  handle @pds2 {
    reverse_proxy pds2:3000
  }
  handle {
    reverse_proxy entryway:3000
  }
}
`,
);
await writeFile(
  `${dirname(configPath)}/Corefile`,
  `.:53 {
  errors
  template IN A entryway.test entryway.example.com {
    match ^(?:.*\\.)?entryway\\.(test|example\\.com)\\.$
    answer "{{ .Name }} 60 IN A 172.29.251.2"
    fallthrough
  }
  template IN AAAA entryway.test entryway.example.com {
    rcode NOERROR
  }
  forward . 127.0.0.11
  cache 30
}
`,
);
console.log(
  JSON.stringify({
    issuer: config.issuer,
    pds: config.pds.map(({ id, url }) => ({ id, url })),
  }),
);
