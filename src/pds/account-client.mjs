import { randomBytes } from "node:crypto";
import { importJWK, SignJWT } from "jose";

import { fail } from "../accounts/input.mjs";
import { xrpc } from "./client.mjs";

export async function createPdsAccountClient({ config, accounts }) {
  const jwtKey = await importJWK(config.jwtJwk, "ES256K");
  const internalAccess = async (row) =>
    new SignJWT({ scope: "com.atproto.access" })
      .setProtectedHeader({ alg: "ES256K", typ: "at+jwt" })
      .setSubject(row.did)
      .setAudience(accounts.pdsFor(row).did)
      .setIssuedAt()
      .setExpirationTime("30s")
      .setJti(randomBytes(16).toString("hex"))
      .sign(jwtKey);
  const pdsCall = async (row, nsid, body) =>
    xrpc(
      accounts.pdsFor(row).internalUrl,
      nsid,
      body,
      `Bearer ${await internalAccess(row)}`,
    );
  const choosePds = (pdsId) => {
    const pds = config.pds.find((p) => p.id === (pdsId ?? config.pds[0].id));
    if (!pds) fail("InvalidPds", "Choose an enrolled PDS");
    return pds;
  };
  return { pdsCall, choosePds };
}
