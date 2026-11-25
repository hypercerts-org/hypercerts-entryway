import { createECDH, ECDH, timingSafeEqual } from "node:crypto";
import { JoseKey } from "@atproto/oauth-provider/provider";
import { pdsPublicTrust } from "../features/pds-registry/trust.mjs";
import { genesisRotationKeys } from "../plc/policy.js";
import { Secp256k1MigrationPlcSigner } from "../plc/signing.js";

/** Check the same immutable startup configuration before activation and serving. */
export async function validateRegistryServingConfiguration(
  config,
  keyring,
  verifier,
) {
  if (!keyring || !verifier || !Array.isArray(config.pds) || config.pds.length)
    throw new Error("RegistryServingUnavailable");
  try {
    const privateKey = config.jwtJwk;
    if (
      privateKey?.kty !== "EC" ||
      privateKey.crv !== "secp256k1" ||
      typeof privateKey.d !== "string" ||
      typeof privateKey.x !== "string" ||
      typeof privateKey.y !== "string"
    )
      throw new Error();
    const coordinates = [privateKey.d, privateKey.x, privateKey.y].map(
      (value) => {
        const bytes = Buffer.from(value, "base64url");
        if (bytes.length !== 32 || bytes.toString("base64url") !== value)
          throw new Error();
        return bytes;
      },
    );
    const signer = createECDH("secp256k1");
    signer.setPrivateKey(coordinates[0]);
    const actual = signer.getPublicKey(undefined, "compressed");
    const advertised = ECDH.convertKey(
      config.jwtPublicHex,
      "secp256k1",
      "hex",
      undefined,
      "compressed",
    );
    const declared = ECDH.convertKey(
      Buffer.concat([Buffer.from([4]), coordinates[1], coordinates[2]]),
      "secp256k1",
      undefined,
      undefined,
      "compressed",
    );
    if (
      actual.length !== advertised.length ||
      actual.length !== declared.length ||
      !timingSafeEqual(actual, advertised) ||
      !timingSafeEqual(actual, declared)
    )
      throw new Error();
    await JoseKey.fromJWK(privateKey);
  } catch {
    throw new Error("RegistrySigningKeyConflict");
  }
  try {
    pdsPublicTrust(config);
    new URL(config.clientUrl);
    new URL(config.plcUrl);
    if (
      typeof config.dpopSecret !== "string" ||
      !/^[0-9a-f]{64}$/i.test(config.dpopSecret) ||
      typeof config.betterAuthSecret !== "string" ||
      !config.betterAuthSecret
    )
      throw new Error();
    const signer = await Secp256k1MigrationPlcSigner.fromHex(
      config.plcRotationKeyHex,
    );
    genesisRotationKeys({
      offline: config.plcRecoveryKeyDid,
      hot: signer.publicKey(),
    });
    if (config.plcRotationKeyDid !== signer.publicKey()) throw new Error();
  } catch {
    throw new Error("RegistryServingUnavailable");
  }
}
