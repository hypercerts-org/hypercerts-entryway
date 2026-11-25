import { ECDH } from "node:crypto";
import { isValidDid } from "@atproto/syntax";
import { publicRotationKey } from "../../plc/policy.js";

export function pdsPublicTrust(config) {
  try {
    if (
      ![
        config.issuer,
        config.serviceDid,
        config.jwtPublicHex,
        config.plcRotationKeyDid,
      ].every((value) => typeof value === "string" && value.length > 0)
    )
      throw new Error();
    const issuer = new URL(config.issuer);
    if (
      issuer.protocol !== "https:" ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      !isValidDid(config.serviceDid)
    )
      throw new Error();
    publicRotationKey(config.plcRotationKeyDid);
    if (
      !/^(?:(?:02|03)[0-9a-f]{64}|04[0-9a-f]{128})$/i.test(config.jwtPublicHex)
    )
      throw new Error();
    ECDH.convertKey(
      config.jwtPublicHex,
      "secp256k1",
      "hex",
      "hex",
      "compressed",
    );
    return {
      issuer: config.issuer,
      serviceDid: config.serviceDid,
      jwtPublicKeyHex: config.jwtPublicHex,
      plcRotationKeyDid: config.plcRotationKeyDid,
    };
  } catch {
    throw new Error("PdsTrustConfigurationUnavailable");
  }
}
