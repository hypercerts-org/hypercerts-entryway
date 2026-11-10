import { getVerificationMaterial } from "@atproto/common";
import { getDidKeyFromMultibase } from "@atproto/identity";
import type { DidDocument } from "@atproto/identity";
import { verifyJwt } from "@atproto/xrpc-server";
import { DomainError } from "../../accounts/errors.js";
import type { ArrivalReplayFacts } from "./arrival-types.js";

/** Incoming source credentials authorize one Entryway method for one DID. They
 * are never hosted-account authorization and never mint a local account. */
export const incomingHandoffMethod =
  "com.atproto.identity.submitPlcOperation" as const;
export const incomingCreationMethod =
  "com.atproto.server.createAccount" as const;

export type IncomingMethod =
  | typeof incomingHandoffMethod
  | typeof incomingCreationMethod;

/** Verified, secret-free facts. Replay admission of these facts stays with the
 * caller's fenced storage transaction; this verifier consumes nothing. */
export interface IncomingAuthorization {
  readonly did: string;
  readonly method: IncomingMethod;
  readonly replayFacts: ArrivalReplayFacts;
}

const rejected = (): never => {
  throw new DomainError(
    "AccountMismatch",
    403,
    "The source credential does not authorize this arrival",
  );
};

/** Accept only a bearer credential; cookies and query parameters never authorize. */
const presentation = (value: unknown): string => {
  if (typeof value !== "string") return rejected();
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(value.trim());
  if (!match) return rejected();
  const token = match[1];
  if (!token) return rejected();
  return token;
};

/** Verify source credentials without touching hosted-account authentication.
 * `readDirectory` is the configured concrete directory reader; this layer never
 * follows a caller-supplied origin or plaintext discovery. */
export function createIncomingAuthorization({
  serviceDid,
  readDirectory,
}: {
  readonly serviceDid: string;
  readonly readDirectory: (did: string) => Promise<DidDocument>;
}) {
  /** A source service JWT names its own DID or its #atproto method; either way
   * the repository verification key is what proves the signature. Legacy
   * `did:key` verification methods are authoritative references, so the key is
   * resolved through the configured directory and never from the token itself. */
  const signingKey = async (issuer: string): Promise<string> => {
    const did = issuer.split("#")[0];
    if (!did || (issuer !== did && issuer !== `${did}#atproto`))
      return rejected();
    const document = await readDirectory(did);
    const methods = document.verificationMethod?.filter(
      (method) => method.id === `${did}#atproto` || method.id === "#atproto",
    );
    if (
      document.id !== did ||
      methods?.length !== 1 ||
      methods[0]?.controller !== did
    )
      return rejected();
    const material = getVerificationMaterial(document, "atproto");
    if (!material || !material.type || !material.publicKeyMultibase)
      return rejected();
    if (material.publicKeyMultibase.startsWith("did:key:"))
      return material.publicKeyMultibase;
    const didKey = getDidKeyFromMultibase(material);
    if (!didKey) return rejected();
    return didKey;
  };
  return async function verifyIncomingAuthorization(input: {
    readonly presentation: unknown;
    readonly method: IncomingMethod;
    readonly operationId: string;
    readonly requestDigest: string;
    readonly expectedDid?: string;
  }): Promise<IncomingAuthorization> {
    const token = presentation(input.presentation);
    if (!/^[a-f0-9]{64}$/.test(input.requestDigest)) return rejected();
    let subject: string;
    let credentialIssuer: string;
    let credentialJti: string;
    try {
      const payload: unknown = await verifyJwt(
        token,
        serviceDid,
        input.method,
        async (issuer) => await signingKey(issuer),
      );
      const claims = payload as Record<string, unknown>;
      const issuer = claims.iss;
      if (typeof issuer !== "string") return rejected();
      subject = String(issuer).split("#")[0] ?? "";
      const now = Math.floor(Date.now() / 1000);
      if (
        claims.aud !== serviceDid ||
        claims.lxm !== input.method ||
        typeof claims.jti !== "string" ||
        !claims.jti
      )
        return rejected();
      credentialIssuer = issuer;
      credentialJti = claims.jti;
      const issuedAt = claims.iat;
      const expiresAt = claims.exp;
      if (
        typeof issuedAt !== "number" ||
        !Number.isInteger(issuedAt) ||
        typeof expiresAt !== "number" ||
        !Number.isInteger(expiresAt) ||
        expiresAt <= now ||
        expiresAt <= issuedAt ||
        expiresAt - issuedAt > 300 ||
        issuedAt > now + 60
      )
        return rejected();
    } catch {
      return rejected();
    }
    if (!/^did:plc:[a-z2-7]{24}$/.test(subject)) return rejected();
    if (input.expectedDid !== undefined && subject !== input.expectedDid)
      return rejected();
    return {
      did: subject,
      method: input.method,
      replayFacts: {
        operationId: input.operationId,
        did: subject,
        method: input.method,
        requestDigest: input.requestDigest,
        credentialIssuer,
        credentialJti,
      },
    };
  };
}

export type VerifyIncomingAuthorization = ReturnType<
  typeof createIncomingAuthorization
>;
