import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import { isValidDid } from "@atproto/syntax";

/** Internal protocol only. No schema value grants a route or PDS authority. */
export const CONTROLLER_VERSION = 1 as const;
export const CONTROLLER_MAX_JSON_BYTES = 65_536;
export const CONTROLLER_MAX_STATEMENT_AGE_MS = 30_000;
export const CONTROLLER_MAX_LEASE_MS = 30_000;
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const timestamp = z.number().int().safe().nonnegative();
const endpoint = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.href === value
      );
    } catch {
      return false;
    }
  });
const method = z.enum([
  "com.atproto.server.reserveSigningKey",
  "com.atproto.server.createAccount",
  "com.atproto.repo.importRepo",
  "com.atproto.repo.uploadBlob",
  "com.atproto.server.activateAccount",
  "com.atproto.identity.submitPlcOperation",
]);
export const controllerBindingSchema = z.strictObject({
  version: z.literal(CONTROLLER_VERSION),
  issuer: id,
  keyId: id,
  audience: id,
  nonce: challenge,
  purpose: z.literal("describe-binding"),
  controllerEpoch: id,
  deploymentId: id,
  hostId: id,
  revision: z.number().int().safe().positive(),
  serviceDid: z.string().max(2048).refine(isValidDid),
  publicEndpoint: endpoint,
  routeId: id,
  generation: z.number().int().safe().positive(),
  imageDigest: digest,
  configDigest: digest,
  launcherDigest: digest,
  incarnation: id,
  observedAt: timestamp,
  expiresAt: timestamp,
  signature,
});
export type ControllerBinding = z.infer<typeof controllerBindingSchema>;
export const controllerBindingExpectationSchema = controllerBindingSchema.pick({
  issuer: true,
  audience: true,
  nonce: true,
  controllerEpoch: true,
  deploymentId: true,
  hostId: true,
  revision: true,
  serviceDid: true,
  publicEndpoint: true,
});

/** Stable authority identifies the fleet, not a particular rotating worker credential. */
export const controllerDescribeRequestSchema = z.strictObject({
  version: z.literal(CONTROLLER_VERSION),
  authorityId: id,
  callerId: id,
  deploymentId: id,
  hostId: id,
  revision: z.number().int().safe().positive(),
  controllerEpoch: id,
  purpose: z.literal("describe-binding"),
  nonce: challenge,
});
export const controllerRouteRequestSchema = z.strictObject({
  version: z.literal(CONTROLLER_VERSION),
  authorityId: id,
  callerId: id,
  controllerEpoch: id,
  deploymentId: id,
  hostId: id,
  revision: z.number().int().safe().positive(),
  generation: z.number().int().safe().positive(),
  incarnation: id,
  operationId: id,
  attemptId: id,
  requestKey: id,
  purpose: z.enum(["staged-qualification", "staged-arrival"]),
  method,
  intentDigest: digest,
});
export type ControllerRouteRequest = z.infer<
  typeof controllerRouteRequestSchema
>;
export const controllerRouteLeaseSchema = z.strictObject({
  version: z.literal(CONTROLLER_VERSION),
  authorityId: id,
  callerId: id,
  controllerEpoch: id,
  deploymentId: id,
  hostId: id,
  revision: z.number().int().safe().positive(),
  generation: z.number().int().safe().positive(),
  incarnation: id,
  operationId: id,
  attemptId: id,
  requestKey: id,
  purpose: z.enum(["staged-qualification", "staged-arrival"]),
  method,
  intentDigest: digest,
  capability: z.string().regex(/^[A-Za-z0-9_-]{43,512}$/),
  issuedAt: timestamp,
  expiresAt: timestamp,
});
export type ControllerRouteLease = z.infer<typeof controllerRouteLeaseSchema>;

export const controllerQualificationStartSchema = z.strictObject({
  version: z.literal(CONTROLLER_VERSION),
  authorityId: id,
  runnerId: id,
  deploymentId: id,
  hostId: id,
  revision: z.number().int().safe().positive(),
  manifestDigest: digest,
  fixtureDigest: digest,
  entrywayDigest: digest,
  runnerDigest: digest,
  testPlanVersion: id,
  requestKey: id,
});
export const controllerQualificationCaseSchema = z.strictObject({
  caseId: id,
  project: z.enum(["cutover-at-entryway", "cutover-at-destination"]),
  status: z.enum(["passed", "failed", "skipped"]),
  count: z.number().int().safe().nonnegative().max(10000),
  artifactDigest: digest,
});
export const controllerQualificationResultSchema = z.strictObject({
  version: z.literal(CONTROLLER_VERSION),
  runId: id,
  runnerId: id,
  challengeCommitment: digest,
  testPlanVersion: id,
  cases: z.array(controllerQualificationCaseSchema).min(1).max(128),
});
/** A signature proves the controller's statement only; durable import and live route checks remain mandatory. */
export const controllerQualificationCompletionSchema = controllerBindingSchema
  .pick({
    version: true,
    issuer: true,
    keyId: true,
    audience: true,
    controllerEpoch: true,
    deploymentId: true,
    hostId: true,
    revision: true,
    serviceDid: true,
    publicEndpoint: true,
    routeId: true,
    generation: true,
    imageDigest: true,
    configDigest: true,
    launcherDigest: true,
    incarnation: true,
  })
  .extend({
    purpose: z.literal("qualification-complete"),
    runId: id,
    runnerId: id,
    runnerDigest: digest,
    fixtureDigest: digest,
    entrywayDigest: digest,
    manifestDigest: digest,
    credentialRefsDigest: digest,
    publicIngressDigest: digest,
    testPlanVersion: id,
    challengeCommitment: digest,
    resultDigest: digest,
    startedAt: timestamp,
    deadline: timestamp,
    finishedAt: timestamp,
    expiresAt: timestamp,
    signature,
  });
export type ControllerQualificationCompletion = z.infer<
  typeof controllerQualificationCompletionSchema
>;
export const controllerQualificationExpectationSchema =
  controllerQualificationCompletionSchema.omit({
    signature: true,
    startedAt: true,
    finishedAt: true,
    expiresAt: true,
  });
export type ControllerQualificationExpectation = z.infer<
  typeof controllerQualificationExpectationSchema
>;

/** Fixed field order is part of the versioned signature contract. */
export function controllerQualificationCompletionBytes(
  value: Omit<ControllerQualificationCompletion, "signature">,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "entryway-controller-qualification",
      value.version,
      value.issuer,
      value.keyId,
      value.audience,
      value.purpose,
      value.controllerEpoch,
      value.deploymentId,
      value.hostId,
      value.revision,
      value.serviceDid,
      value.publicEndpoint,
      value.routeId,
      value.generation,
      value.imageDigest,
      value.configDigest,
      value.launcherDigest,
      value.incarnation,
      value.runId,
      value.runnerId,
      value.runnerDigest,
      value.fixtureDigest,
      value.entrywayDigest,
      value.manifestDigest,
      value.credentialRefsDigest,
      value.publicIngressDigest,
      value.testPlanVersion,
      value.challengeCommitment,
      value.resultDigest,
      value.startedAt,
      value.deadline,
      value.finishedAt,
      value.expiresAt,
    ]),
  );
}

/** Validate the controller-pinned required cases before hashing a runner result. */
export function controllerQualificationResultDigest(
  value: unknown,
  required: readonly Pick<
    z.infer<typeof controllerQualificationCaseSchema>,
    "project" | "caseId" | "count"
  >[],
): string {
  const result = controllerQualificationResultSchema.safeParse(value);
  const requiredCase = controllerQualificationCaseSchema.pick({
    project: true,
    caseId: true,
    count: true,
  });
  if (!result.success || !required.length || required.length > 128)
    return invalid();
  const expected = new Map<string, number>();
  for (const entry of required) {
    const item = requiredCase.safeParse(entry);
    if (!item.success || item.data.count < 1) return invalid();
    const key = JSON.stringify([item.data.project, item.data.caseId]);
    if (expected.has(key)) return invalid();
    expected.set(key, item.data.count);
  }
  if (result.data.cases.length !== expected.size) return invalid();
  const seen = new Set<string>();
  const cases = result.data.cases
    .map((item) => {
      const key = JSON.stringify([item.project, item.caseId]);
      if (
        seen.has(key) ||
        item.status !== "passed" ||
        expected.get(key) !== item.count
      )
        return invalid();
      seen.add(key);
      return [
        item.project,
        item.caseId,
        item.status,
        item.count,
        item.artifactDigest,
      ] as const;
    })
    .sort((left, right) => {
      const a = JSON.stringify(left);
      const b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        "entryway-controller-result",
        result.data.version,
        result.data.runId,
        result.data.runnerId,
        result.data.challengeCommitment,
        result.data.testPlanVersion,
        cases,
      ]),
    )
    .digest("hex")}`;
}

/** Verify a completion against independently established context. This does not consume its run ID. */
export function verifyControllerQualificationCompletion(
  raw: string,
  expected: ControllerQualificationExpectation,
  keys: ReadonlyMap<string, ReadonlyMap<string, string | Buffer | KeyObject>>,
  now: number,
  maximumAgeMs: number,
): ControllerQualificationCompletion {
  const result = controllerQualificationCompletionSchema.safeParse(
    parseControllerJson(raw),
  );
  const context = controllerQualificationExpectationSchema.safeParse(expected);
  if (!result.success || !context.success) return invalid();
  const completion = result.data;
  let key: KeyObject;
  try {
    const configured = keys.get(completion.issuer)?.get(completion.keyId);
    if (!configured) throw Error();
    key =
      configured instanceof Object && "type" in configured
        ? (configured as KeyObject)
        : createPublicKey(configured);
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519")
      throw Error();
    if (
      Buffer.from(completion.signature, "base64url").toString("base64url") !==
        completion.signature ||
      !verify(
        null,
        controllerQualificationCompletionBytes(completion),
        key,
        Buffer.from(completion.signature, "base64url"),
      )
    )
      throw Error();
  } catch {
    throw new ControllerContractError("ControllerIdentityMismatch");
  }
  if (
    Object.keys(context.data).some(
      (field) =>
        completion[field as keyof ControllerQualificationExpectation] !==
        context.data[field as keyof ControllerQualificationExpectation],
    )
  )
    throw new ControllerContractError("ControllerIdentityMismatch");
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(maximumAgeMs) ||
    maximumAgeMs < 1 ||
    completion.startedAt >= completion.deadline ||
    completion.finishedAt < completion.startedAt ||
    completion.finishedAt >= completion.deadline ||
    completion.finishedAt > now ||
    completion.expiresAt <= completion.finishedAt ||
    completion.expiresAt <= now ||
    completion.expiresAt - completion.finishedAt > maximumAgeMs ||
    now - completion.finishedAt > maximumAgeMs
  )
    throw new ControllerContractError("ControllerExpired");
  return completion;
}

export const controllerFreezeStatusSchema = z.strictObject({
  version: z.literal(CONTROLLER_VERSION),
  deploymentId: id,
  generation: z.number().int().safe().positive(),
  controllerEpoch: id,
  admissionClosed: z.boolean(),
  dispatchersIsolated: z.boolean(),
  ingressDrained: z.boolean(),
  unresolvedUpstream: z.number().int().safe().nonnegative(),
});
/** This tests completeness only; the caller must authenticate and bind the statement. */
export function controllerFreezeFactsComplete(value: unknown): boolean {
  const result = controllerFreezeStatusSchema.safeParse(value);
  if (!result.success) return invalid();
  const state = result.data;
  return (
    state.admissionClosed &&
    state.dispatchersIsolated &&
    state.ingressDrained &&
    state.unresolvedUpstream === 0
  );
}
export type ControllerErrorCode =
  | "ControllerInvalidResponse"
  | "ControllerIdentityMismatch"
  | "ControllerChallengeReplayed"
  | "ControllerExpired"
  | "ControllerUnavailable"
  | "ControllerUncertain";
export class ControllerContractError extends Error {
  constructor(readonly code: ControllerErrorCode) {
    super(code);
  }
}
function invalid(): never {
  throw new ControllerContractError("ControllerInvalidResponse");
}
export function parseControllerJson(raw: string): unknown {
  if (Buffer.byteLength(raw, "utf8") > CONTROLLER_MAX_JSON_BYTES)
    return invalid();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return invalid();
  }
}
/** Fixed ordered fields avoid object-order ambiguity in signed statements. */
export function controllerBindingBytes(
  value: Omit<ControllerBinding, "signature">,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "entryway-controller-binding",
      value.version,
      value.issuer,
      value.keyId,
      value.audience,
      value.nonce,
      value.purpose,
      value.controllerEpoch,
      value.deploymentId,
      value.hostId,
      value.revision,
      value.serviceDid,
      value.publicEndpoint,
      value.routeId,
      value.generation,
      value.imageDigest,
      value.configDigest,
      value.launcherDigest,
      value.incarnation,
      value.observedAt,
      value.expiresAt,
    ]),
  );
}
export interface ControllerBindingExpectation {
  issuer: string;
  audience: string;
  nonce: string;
  controllerEpoch: string;
  deploymentId: string;
  hostId: string;
  revision: number;
  serviceDid: string;
  publicEndpoint: string;
}
/** Consumer must atomically match an issued, unexpired challenge and mark it used
 * in shared durable state. A process-local set is insufficient across workers. */
export type ConsumeControllerChallenge = (
  binding: ControllerBinding,
  expected: ControllerBindingExpectation,
) => Promise<boolean>;
export class ControllerBindingVerifier {
  private readonly keys: Map<string, Map<string, KeyObject>>;
  constructor(
    keys: ReadonlyMap<string, ReadonlyMap<string, string | Buffer | KeyObject>>,
    private readonly consumeChallenge: ConsumeControllerChallenge,
  ) {
    this.keys = new Map(
      [...keys].map(([issuer, issuerKeys]) => [
        issuer,
        new Map(
          [...issuerKeys].map(([keyId, key]) => [
            keyId,
            key instanceof Object && "type" in key
              ? (key as KeyObject)
              : createPublicKey(key),
          ]),
        ),
      ]),
    );
    if (
      !this.keys.size ||
      [...this.keys.values()].some(
        (issuerKeys) =>
          !issuerKeys.size ||
          [...issuerKeys.values()].some(
            (key) =>
              key.type !== "public" || key.asymmetricKeyType !== "ed25519",
          ),
      )
    )
      invalid();
  }
  async verify(
    raw: string,
    expected: ControllerBindingExpectation,
    clock: () => number,
  ): Promise<ControllerBinding> {
    const now = clock();
    const result = controllerBindingSchema.safeParse(parseControllerJson(raw));
    if (!result.success) return invalid();
    const binding = result.data;
    const key = this.keys.get(binding.issuer)?.get(binding.keyId);
    if (
      !key ||
      Buffer.from(binding.signature, "base64url").toString("base64url") !==
        binding.signature ||
      !verify(
        null,
        controllerBindingBytes(binding),
        key,
        Buffer.from(binding.signature, "base64url"),
      )
    )
      throw new ControllerContractError("ControllerIdentityMismatch");
    if (
      [
        "issuer",
        "audience",
        "nonce",
        "controllerEpoch",
        "deploymentId",
        "hostId",
        "revision",
        "serviceDid",
        "publicEndpoint",
      ].some(
        (field) =>
          binding[field as keyof ControllerBindingExpectation] !==
          expected[field as keyof ControllerBindingExpectation],
      )
    )
      throw new ControllerContractError("ControllerIdentityMismatch");
    if (
      !Number.isSafeInteger(now) ||
      binding.observedAt > now ||
      binding.expiresAt <= now ||
      binding.expiresAt <= binding.observedAt ||
      binding.expiresAt - binding.observedAt > CONTROLLER_MAX_STATEMENT_AGE_MS
    )
      throw new ControllerContractError("ControllerExpired");
    let consumed: boolean;
    try {
      consumed = await this.consumeChallenge(binding, expected);
    } catch {
      throw new ControllerContractError("ControllerUnavailable");
    }
    if (consumed !== true)
      throw new ControllerContractError("ControllerChallengeReplayed");
    const completedAt = clock();
    if (
      !Number.isSafeInteger(completedAt) ||
      completedAt < now ||
      completedAt >= binding.expiresAt
    )
      throw new ControllerContractError("ControllerExpired");
    return binding;
  }
}

/** Match a lease to its original request before any network admission. */
export function validateControllerLease(
  value: unknown,
  request: ControllerRouteRequest,
  now: number,
  minimumBudgetMs: number,
): ControllerRouteLease {
  const result = controllerRouteLeaseSchema.safeParse(value);
  if (!result.success) return invalid();
  const lease = result.data;
  const fields = [
    "authorityId",
    "callerId",
    "controllerEpoch",
    "deploymentId",
    "hostId",
    "revision",
    "generation",
    "incarnation",
    "operationId",
    "attemptId",
    "requestKey",
    "purpose",
    "method",
    "intentDigest",
  ] as const;
  if (fields.some((field) => lease[field] !== request[field]))
    throw new ControllerContractError("ControllerIdentityMismatch");
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(minimumBudgetMs) ||
    minimumBudgetMs < 0 ||
    lease.issuedAt > now ||
    lease.expiresAt <= lease.issuedAt ||
    lease.expiresAt - lease.issuedAt > CONTROLLER_MAX_LEASE_MS ||
    lease.expiresAt - now < minimumBudgetMs ||
    lease.expiresAt <= now
  )
    throw new ControllerContractError("ControllerExpired");
  return lease;
}
/** A controller must persist this key atomically before forwarding. */
export function controllerDispatchKey(request: ControllerRouteRequest): string {
  return JSON.stringify([
    request.authorityId,
    request.operationId,
    request.attemptId,
  ]);
}

export const controllerDispatchReceiptSchema = z.strictObject({
  version: z.literal(CONTROLLER_VERSION),
  authorityId: id,
  controllerEpoch: id,
  deploymentId: id,
  hostId: id,
  revision: z.number().int().safe().positive(),
  generation: z.number().int().safe().positive(),
  incarnation: id,
  operationId: id,
  attemptId: id,
  purpose: z.enum(["staged-qualification", "staged-arrival"]),
  method,
  intentDigest: digest,
  state: z.enum(["pending", "uncertain", "completed"]),
  resultDigest: digest.optional(),
});
/** Parsing a receipt never authorizes retry: pending and uncertainty both hold. */
export function controllerDispatchDisposition(
  value: unknown,
  request: ControllerRouteRequest,
): "hold" | "completed" {
  const result = controllerDispatchReceiptSchema.safeParse(value);
  if (!result.success) return invalid();
  const receipt = result.data;
  const fields = [
    "authorityId",
    "controllerEpoch",
    "deploymentId",
    "hostId",
    "revision",
    "generation",
    "incarnation",
    "operationId",
    "attemptId",
    "purpose",
    "method",
    "intentDigest",
  ] as const;
  if (fields.some((field) => receipt[field] !== request[field]))
    throw new ControllerContractError("ControllerIdentityMismatch");
  if ((receipt.state === "completed") !== (receipt.resultDigest !== undefined))
    return invalid();
  return receipt.state === "completed" ? "completed" : "hold";
}
