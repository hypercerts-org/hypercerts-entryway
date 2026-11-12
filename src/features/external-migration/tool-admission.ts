import { HttpError } from "../../http/http-error.mjs";
import type { ArrivalTransactor } from "../../database/migration-journal.port.js";
import { DomainError } from "../../accounts/errors.js";
import type { TrackedArrivalSession } from "./arrival-credentials.js";
import {
  incomingCreationMethod,
  incomingHandoffMethod,
  type IncomingMethod,
  type VerifyIncomingAuthorization,
} from "./incoming-authorization.js";
import { parseArrivalRequest } from "./arrival-request.js";
import type { ArrivalRecord } from "./arrival-types.js";
import { arrivalCodeHash } from "./prepare-arrival.js";
import { PlcError } from "../../plc/errors.js";

/** Identity-layer failures carry no HTTP status. Map them to stable public
 * codes; the message is the fixed public text, never a candidate or key. */
async function stableIdentity<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof PlcError)) throw error;
    if (error.code === "InvalidPlcOperation")
      throw new HttpError(400, "InvalidPlcOperation", error.message);
    throw new HttpError(
      409,
      "IdentityConflict",
      "The canonical identity history does not allow this arrival",
    );
  }
}

/**
 * Cookie-less admission for the migration tool.
 *
 * PROPOSED RESOLUTION, NOT AN ACCEPTED CONTRACT. C1 says the tool surfaces never
 * accept or export browser cookies, but admission and continuation otherwise
 * resolve their owner from a browser principal. Until the owner decides, this is
 * the single place that selects an arrival for the XRPC surfaces: the presented
 * current, unexpired arrival code selects the arrival and the user saved on it.
 * The user is never taken from an email, a request value or the credential, and
 * the method-bound source JWT is still verified by admission exactly as before.
 * Replacing this resolution means replacing `select` below and nothing else.
 *
 * What the code alone permits before the source JWT verifies: reading the
 * arrival row and contending for the arrival's ownership lease (a denial of
 * service limited by the caller's request budget). It records nothing, signs
 * nothing and dispatches nothing. Every failure to select an arrival, including
 * an unparsable credential, is the same `ArrivalExpired`, so a caller without the
 * code learns nothing about any DID, operation or user.
 */
const codeShape = /^[A-Za-z0-9_-]{16,128}$/;
const bearerShape = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;
const issuerShape = /^(did:plc:[a-z2-7]{24})(?:#atproto)?$/;

const expired = () =>
  new HttpError(409, "ArrivalExpired", "This arrival code is no longer valid");

/** The DID a presented source credential claims, read WITHOUT verifying it. It
 * only picks which arrival to look up; admission verifies the signature, the
 * method, the audience and that this DID is the arrival's DID. */
function claimedDid(presentation: unknown): string | null {
  if (typeof presentation !== "string") return null;
  const token = bearerShape.exec(presentation.trim())?.[1];
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const issuer =
      claims && typeof claims === "object"
        ? (claims as Record<string, unknown>).iss
        : undefined;
    return typeof issuer === "string"
      ? (issuerShape.exec(issuer)?.[1] ?? null)
      : null;
  } catch {
    return null;
  }
}

export interface ToolAdmissionInput {
  readonly arrivalCode: unknown;
  readonly presentation: unknown;
  readonly body: unknown;
}

export function createToolAdmission({
  arrivals,
  admit,
  verify,
  continueCreation,
  issueCreationSession,
}: {
  verify: VerifyIncomingAuthorization;
  arrivals: Pick<ArrivalTransactor, "consumeArrivalCode">;
  admit: (input: {
    operationId: string;
    userId: string;
    method: IncomingMethod;
    body: unknown;
    presentation: unknown;
    arrivalCode: string;
  }) => Promise<unknown>;
  continueCreation: (input: {
    operationId: string;
    userId: string;
  }) => Promise<unknown>;
  issueCreationSession: (input: {
    did: string;
    operationId: string;
    arrivalCode: string;
  }) => Promise<TrackedArrivalSession>;
}) {
  /** The one selection point. Method first, then a current code. */
  const select = async (
    method: IncomingMethod,
    input: ToolAdmissionInput,
  ): Promise<{ record: ArrivalRecord; arrivalCode: string }> => {
    if (method !== incomingHandoffMethod && method !== incomingCreationMethod)
      throw new HttpError(400, "InvalidRequest", "Unsupported incoming method");
    const arrivalCode = input.arrivalCode;
    const did = claimedDid(input.presentation);
    if (typeof arrivalCode !== "string" || !codeShape.test(arrivalCode) || !did)
      throw expired();
    const record = await arrivals.consumeArrivalCode({
      codeHash: arrivalCodeHash(arrivalCode),
      did,
      method,
    });
    if (!record) throw expired();
    // The code only selects. The method-bound source credential is verified
    // with the same verifier and request digest admission uses, BEFORE any
    // ownership lease is taken, so a leaked code with a bad credential cannot
    // contend for the arrival. Verification consumes no replay state; admission
    // verifies again and records it.
    const parsed = parseArrivalRequest(record, method, input.body);
    await verify({
      presentation: input.presentation,
      method,
      operationId: record.operationId,
      requestDigest: parsed.requestDigest,
      expectedDid: record.did,
    });
    return { record, arrivalCode };
  };
  return {
    /** The standard identity submit: success is exactly the canonical handoff. */
    async submitHandoff(
      input: ToolAdmissionInput,
    ): Promise<Record<string, never>> {
      const { record, arrivalCode } = await select(
        incomingHandoffMethod,
        input,
      );
      const result = (await stableIdentity(() =>
        admit({
          operationId: record.operationId,
          userId: record.userId,
          method: incomingHandoffMethod,
          body: input.body,
          presentation: input.presentation,
          arrivalCode,
        }),
      )) as { state?: string } | undefined;
      // A lost or not-yet-canonical publication stays saved; the exact request
      // is the retry. Never report publication that was not observed.
      if (result?.state !== "published")
        throw new DomainError(
          "OperationRecoveryRequired",
          409,
          "The handoff is saved but not yet observed as published; retry the same request",
        );
      return {};
    },
    /** The standard account creation, returning tracked credentials only after
     * the saved binding and the credential family committed together. */
    async createAccount(
      input: ToolAdmissionInput,
    ): Promise<TrackedArrivalSession> {
      const { record, arrivalCode } = await select(
        incomingCreationMethod,
        input,
      );
      return stableIdentity(async () => {
        await admit({
          operationId: record.operationId,
          userId: record.userId,
          method: incomingCreationMethod,
          body: input.body,
          presentation: input.presentation,
          arrivalCode,
        });
        await continueCreation({
          operationId: record.operationId,
          userId: record.userId,
        });
        return issueCreationSession({
          did: record.did,
          operationId: record.operationId,
          arrivalCode,
        });
      });
    },
  };
}
