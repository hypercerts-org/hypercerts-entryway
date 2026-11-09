import { randomBytes } from "node:crypto";
import { parseDidKey } from "@atproto/crypto";
import { importJWK, SignJWT } from "jose";
import type { JWK } from "jose";
import { DomainError } from "../accounts/errors.js";

/** A stock PDS holds the reserved repository private key. This client only ever
 * receives public key material and never persists a returned session. */
const responseLimit = 1_000_000;

const upstreamFailure = (method: string, status: number): DomainError =>
  new DomainError(
    "AccountUnavailable",
    502,
    `The selected PDS failed ${method} with status ${status}`,
  );

const invalidResponse = (method: string): DomainError =>
  new DomainError(
    "AccountUnavailable",
    502,
    `The selected PDS returned an invalid ${method} response`,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const supportedRepositoryKey = /^did:key:zQ3sh[1-9A-HJ-NP-Za-km-z]{44}$/;

/** Validate a reservation result as a supported public secp256k1 did:key. */
export function reservationSigningKey(value: unknown): string {
  const method = "com.atproto.server.reserveSigningKey";
  if (!isRecord(value) || typeof value.signingKey !== "string")
    throw invalidResponse(method);
  if (!supportedRepositoryKey.test(value.signingKey))
    throw invalidResponse(method);
  try {
    parseDidKey(value.signingKey);
  } catch {
    throw invalidResponse(method);
  }
  return value.signingKey;
}

async function readPublicJson(
  response: Response,
  method: string,
): Promise<unknown> {
  const content = await response.text().catch(() => "");
  if (!response.ok) throw upstreamFailure(method, response.status);
  if (content.length > responseLimit) throw invalidResponse(method);
  if (!content.trim()) return {};
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw invalidResponse(method);
  }
}

/** Concrete stock PDS transport for one selected destination. It carries no
 * lifecycle-hook or administration credential: ordinary `createAccount` with a
 * caller-signed move, then self-deactivation with the account credential. */
export class ArrivalPdsClient {
  readonly #jwtKey: Promise<Awaited<ReturnType<typeof importJWK>>>;
  public constructor(
    private readonly options: {
      readonly endpoint: string;
      readonly did: string;
      readonly jwtJwk: JWK;
    },
  ) {
    this.#jwtKey = importJWK(options.jwtJwk, "ES256K");
  }
  #url(method: string): URL {
    return new URL(`/xrpc/${method}`, this.options.endpoint);
  }
  async #accountAccess(did: string): Promise<string> {
    const key = await this.#jwtKey;
    return await new SignJWT({ scope: "com.atproto.access" })
      .setProtectedHeader({ alg: "ES256K", typ: "at+jwt" })
      .setSubject(did)
      .setAudience(did)
      .setIssuedAt()
      .setExpirationTime("30s")
      .setJti(randomBytes(16).toString("hex"))
      .sign(key);
  }
  /** Stock reservation is unauthenticated and echoes neither DID nor host: the
   * caller binds the result through its own durable intent, not this response. */
  public async reserveSigningKey(did: string): Promise<string> {
    const method = "com.atproto.server.reserveSigningKey";
    const response = await fetch(this.#url(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ did }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    return reservationSigningKey(await readPublicJson(response, method));
  }
  /** Stock creation consumes the PDS-local reservation, publishes the supplied
   * move and returns an active session. Only the public facts are retained. */
  public async createAccount(input: {
    did: string;
    handle: string;
    operation: unknown;
  }): Promise<{ did: string; handle: string }> {
    const method = "com.atproto.server.createAccount";
    const response = await fetch(this.#url(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        did: input.did,
        handle: input.handle,
        plcOp: input.operation,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    const value = await readPublicJson(response, method);
    if (
      !isRecord(value) ||
      value.did !== input.did ||
      value.handle !== input.handle ||
      typeof value.accessJwt !== "string" ||
      typeof value.refreshJwt !== "string"
    )
      throw invalidResponse(method);
    return { did: value.did, handle: value.handle };
  }
  /** Status requires the account's own credential and describes only itself. */
  public async checkAccountStatus(
    did: string,
  ): Promise<{ activated: boolean }> {
    const method = "com.atproto.server.checkAccountStatus";
    const response = await fetch(this.#url(method), {
      method: "GET",
      headers: { authorization: `Bearer ${await this.#accountAccess(did)}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const value = await readPublicJson(response, method);
    if (!isRecord(value) || typeof value.activated !== "boolean")
      throw invalidResponse(method);
    return { activated: value.activated };
  }
  private async deactivationObserved(did: string): Promise<boolean> {
    try {
      return !(await this.checkAccountStatus(did)).activated;
    } catch {
      return false;
    }
  }
  /** Ordinary self-deactivation with the account's own credential, followed by a
   * status read. Callers treat any failure as an unresolved obligation. */
  public async deactivateAccount(did: string): Promise<void> {
    const method = "com.atproto.server.deactivateAccount";
    const response = await fetch(this.#url(method), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await this.#accountAccess(did)}`,
      },
      body: JSON.stringify({}),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    await readPublicJson(response, method);
    if (!(await this.deactivationObserved(did)))
      throw new DomainError(
        "AccountUnavailable",
        502,
        "Destination deactivation is not yet observed",
      );
  }
}
