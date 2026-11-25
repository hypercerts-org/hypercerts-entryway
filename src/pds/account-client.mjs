import { cidForCbor } from "@atproto/common";
import { noExternalResult } from "../accounts/operation-ownership.js";
import { randomBytes } from "node:crypto";
import { importJWK, SignJWT } from "jose";

import { fail } from "../accounts/input.mjs";
import { xrpc, registryXrpc } from "./client.mjs";
import { authorizeRegistryAttempt } from "./registry-policy.mjs";
import { registryPdsTarget } from "./registry-transport.mjs";
import { rejectedPlcSubmission } from "./xrpc-response.js";

export async function createPdsAccountClient({ db, config, accounts }) {
  const jwtKey = await importJWK(config.jwtJwk, "ES256K");
  const internalAccess = async (row, audience) =>
    new SignJWT({ scope: "com.atproto.access" })
      .setProtectedHeader({ alg: "ES256K", typ: "at+jwt" })
      .setSubject(row.did)
      .setAudience(audience ?? (await accounts.pdsFor(row)).did)
      .setIssuedAt()
      .setExpirationTime("30s")
      .setJti(randomBytes(16).toString("hex"))
      .sign(jwtKey);
  const pdsCall = async (row, nsid, body) => {
    const pds = await accounts.pdsFor(row);
    if (accounts.placement)
      registryPdsTarget(
        new URL(`/xrpc/${nsid}`, pds.internalUrl),
        accounts.registryVerifier,
        1024 * 1024,
      );
    const send = async () => {
      if (accounts.placement) await accounts.pdsFor(row);
      return (accounts.placement ? registryXrpc : xrpc)(
        pds.internalUrl,
        nsid,
        body,
        `Bearer ${await internalAccess(row, pds.did)}`,
        accounts.registryVerifier,
      );
    };
    if (body === undefined) return send();
    const dispatch =
      nsid === "com.atproto.identity.submitPlcOperation"
        ? accounts.ownership.dispatchPlcSubmission
        : (input, callbacks) =>
            accounts.ownership.dispatch(
              { ...input, step: nsid, method: nsid },
              callbacks,
            );
    return dispatch(
      {
        target: pds.url ?? pds.internalUrl,
        intent: body,
        ...(accounts.placement
          ? {
              authorizeAttempt: authorizeRegistryAttempt(
                db,
                accounts.placement,
                accounts.registryVerifier,
                pds,
              ),
            }
          : {}),
      },
      {
        ...noExternalResult,
        send,
        rejection: (error) =>
          rejectedPlcSubmission(error, pds.internalUrl, body.operation),
        observe: async () => {
          if (nsid !== "com.atproto.identity.submitPlcOperation")
            return { state: "diverged" };
          const current = (
            await cidForCbor(await accounts.plcClient.getLastOp(row.did))
          ).toString();
          const expected = (await cidForCbor(body.operation)).toString();
          return {
            state:
              current === expected
                ? "applied"
                : current === body.operation.prev
                  ? "unapplied"
                  : "diverged",
            result: {},
          };
        },
      },
    );
  };
  const choosePds = (pdsId) => {
    const pds = config.pds.find((p) => p.id === (pdsId ?? config.pds[0].id));
    if (!pds) fail("InvalidPds", "Choose an enrolled PDS");
    return pds;
  };
  return { pdsCall, choosePds, internalAccess };
}
