import { createHash, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, importJWK, SignJWT } from "jose";
import type { JWK } from "jose";
import type { PublicKeyInventoryItem } from "../plc/types.js";

/** The issuer private JWK is held only by this concrete signer. */
export async function createTargetAccessTokenSigner(input: {
  privateJwk: JWK;
  issuer: string;
  audience: string;
}) {
  const { kty, crv, x, y } = input.privateJwk;
  if (
    kty !== "EC" ||
    crv !== "secp256k1" ||
    typeof x !== "string" ||
    typeof y !== "string"
  )
    throw new Error("InvalidIssuerSigningKey");
  const publicJwk = { kty, crv, x, y };
  const privateKey = await importJWK(input.privateJwk, "ES256K");
  const thumbprint = await calculateJwkThumbprint(publicJwk, "sha256");
  const publicInventoryItem: PublicKeyInventoryItem = {
    keyReference: `jwk-thumbprint:${thumbprint}`,
    purpose: "oauth-issuer",
    custodian: "oauth-issuer",
    algorithm: "ES256K",
    fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(publicJwk)).digest("hex")}`,
    lifecycle: "active",
  };
  return {
    publicInventoryItem,
    sign(did: string) {
      return new SignJWT({ scope: "com.atproto.access" })
        .setProtectedHeader({ typ: "at+jwt", alg: "ES256K" })
        .setIssuer(input.issuer)
        .setSubject(did)
        .setAudience(input.audience)
        .setIssuedAt()
        .setExpirationTime("60s")
        .setJti(randomUUID())
        .sign(privateKey);
    },
  };
}
