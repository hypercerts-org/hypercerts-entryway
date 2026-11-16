import { parseDidKey } from "@atproto/crypto";
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

/** Admin observations must not carry credentials, including in relatedRecords.
 * Stock public additive fields remain allowed; this is not a content scanner. */
function rejectAdminCredentials(value: unknown, method: string): void {
  const remaining: unknown[] = [value];
  const credentialFields = new Set([
    "privatekey",
    "privatekeys",
    "accessjwt",
    "refreshjwt",
    "signingsecret",
  ]);
  while (remaining.length > 0) {
    const current = remaining.pop();
    if (Array.isArray(current)) remaining.push(...current);
    else if (isRecord(current))
      for (const [field, child] of Object.entries(current)) {
        if (credentialFields.has(field.toLowerCase()))
          throw invalidResponse(method);
        remaining.push(child);
      }
  }
}

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

/** For arrival maintainers: stock transport creates with the saved signed move,
 * then inspects and pauses through composition's administrator authorization
 * callbacks without storing an administrator secret on this client. */
export class ArrivalPdsClient {
  public constructor(
    private readonly options: {
      readonly endpoint: string;
      readonly did: string;
    },
  ) {}
  /** Configured administrator credentials stay in composition's signing closure. */
  public async getAccountInfo(
    authorization: () => string,
  ): Promise<{ did: string; handle: string; deactivated: boolean } | null> {
    const method = "com.atproto.admin.getAccountInfo";
    const url = this.#url(method);
    url.searchParams.set("did", this.options.did);
    const response = await fetch(url, {
      headers: { authorization: authorization() },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    // Stock NotFound is an authenticated XRPC InvalidRequest (400), not
    // necessarily HTTP 404. Neither transport errors nor other errors mean absent.
    if (response.status === 400 || response.status === 404) {
      const value: unknown = await response.json().catch(() => null);
      if (isRecord(value) && value.error === "NotFound") return null;
      throw upstreamFailure(method, response.status);
    }
    const value = await readPublicJson(response, method);
    rejectAdminCredentials(value, method);
    if (
      !isRecord(value) ||
      value.did !== this.options.did ||
      typeof value.handle !== "string" ||
      typeof value.indexedAt !== "string" ||
      !Number.isFinite(Date.parse(value.indexedAt)) ||
      (value.deactivatedAt !== undefined &&
        (typeof value.deactivatedAt !== "string" ||
          !Number.isFinite(Date.parse(value.deactivatedAt))))
    )
      throw invalidResponse(method);
    return {
      did: value.did,
      handle: value.handle,
      deactivated: value.deactivatedAt !== undefined,
    };
  }
  public async pauseAccount(authorization: () => string): Promise<void> {
    const method = "com.atproto.admin.updateSubjectStatus";
    const response = await fetch(this.#url(method), {
      method: "POST",
      headers: {
        authorization: authorization(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        subject: {
          $type: "com.atproto.admin.defs#repoRef",
          did: this.options.did,
        },
        deactivated: { applied: true },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    rejectAdminCredentials(await readPublicJson(response, method), method);
  }
  #url(method: string): URL {
    return new URL(`/xrpc/${method}`, this.options.endpoint);
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
}
