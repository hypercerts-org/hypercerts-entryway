import * as plc from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";
import type { DatabaseExecutor } from "../executor.js";
import { registryProtectedResource } from "../../pds/registry-resource.js";
import { validateCustodyObservation } from "../../plc/custody-observation.js";
import { validateCustodyInventory } from "../../plc/custody.js";
import { canonicalJson } from "../../plc/canonical.js";

function unmapped(): never {
  throw new Error("PdsEnrollmentReferencesUnmapped");
}
function object(value: string): Record<string, unknown> {
  try {
    const result: unknown = JSON.parse(value);
    if (result && typeof result === "object" && !Array.isArray(result))
      return result as Record<string, unknown>;
  } catch {
    /* Invalid records are not evidence. */
  }
  return unmapped();
}
function only(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function encodedDate(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    only(record, ["$date"]) &&
    typeof record.$date === "string" &&
    Number.isFinite(Date.parse(record.$date))
  );
}

/** Decode only the completed registration shape; everything else remains blocked. */
export async function assertCompletedSignupReferences(
  db: DatabaseExecutor,
  candidateId: string,
  candidateDids: Set<string>,
  candidateEndpoints: Set<string>,
  canonicalDid: (value: string) => string,
  canonicalEndpoint: (value: string) => string,
): Promise<void> {
  const reservations = await db.read("pds_placement_reservations");
  const operations = await db.read("authority_operations");
  const attempts = await db.read("external_operation_attempts");
  const admissions = await db.read("operation_admissions");
  const history = await db.read("custody_history");
  const custody = await db.read("custody_operations");
  const observations = await db.read("custody_observations");
  const inventories = await db.read("migration_custody_inventory");
  const states = await db.read("key_value_state");
  const accounts = await db.read("accounts");
  const revisions = await db.read("pds_host_revisions");
  const associations = await db.read("pds_host_enrollment_events");
  const revisionKey = (host: string, revision: number) =>
    JSON.stringify([host, revision]);
  const revisionsByKey = new Map(
    revisions.map((row) => [revisionKey(row.host_id, row.revision), row]),
  );
  const associated = new Set(
    associations
      .filter((row) => row.kind === "associate")
      .map((row) => revisionKey(row.host_id, row.revision)),
  );
  const accountsByDid = new Map(accounts.map((row) => [row.did, row]));
  const operationsById = new Map(operations.map((row) => [row.id, row]));
  const attemptsByOperation = new Map<string, typeof attempts>();
  for (const attempt of attempts) {
    const list = attemptsByOperation.get(attempt.operation_id) ?? [];
    list.push(attempt);
    attemptsByOperation.set(attempt.operation_id, list);
  }
  const custodyByKey = new Map(
    custody.map((row) => [JSON.stringify([row.did, row.cid]), row]),
  );
  const byOperation = new Map(
    reservations.map((row) => [row.operation_id, row]),
  );
  if (
    byOperation.size !== reservations.length ||
    operations.length !== reservations.length
  )
    unmapped();
  for (const reservation of reservations) {
    if (
      reservation.purpose !== "registration" ||
      reservation.state !== "dispatched"
    )
      unmapped();
    const key = revisionKey(reservation.host_id, reservation.revision);
    const revision = revisionsByKey.get(key);
    if (
      !revision ||
      !associated.has(key) ||
      revision.staged_incoming_migration ||
      canonicalEndpoint(revision.public_url) !==
        canonicalEndpoint(reservation.public_target) ||
      canonicalEndpoint(revision.internal_url) !==
        canonicalEndpoint(reservation.target)
    )
      unmapped();
    if (
      reservation.host_id === candidateId ||
      candidateDids.has(canonicalDid(revision.service_did)) ||
      candidateEndpoints.has(canonicalEndpoint(revision.public_url)) ||
      candidateEndpoints.has(canonicalEndpoint(revision.internal_url))
    )
      throw new Error("PdsEnrollmentReferencesExist");
    let steps: unknown;
    try {
      steps = JSON.parse(reservation.target_steps);
    } catch {
      unmapped();
    }
    if (
      !Array.isArray(steps) ||
      steps.length !== 2 ||
      !steps.includes("create-account") ||
      !steps.includes("reserve-signing-key")
    )
      unmapped();
    const operation = operationsById.get(reservation.operation_id);
    if (
      !operation ||
      operation.kind !== "create" ||
      operation.state !== "complete" ||
      operation.phase !== "complete" ||
      operation.pending
    )
      unmapped();
    const linked = attemptsByOperation.get(operation.id) ?? [];
    if (
      !linked.some((attempt) => attempt.step === "reserve-signing-key") ||
      !linked.some((attempt) => attempt.step === "create-account") ||
      !linked.some((attempt) => attempt.id === reservation.first_attempt_id)
    )
      unmapped();
    for (const attempt of linked) {
      const expectedMethod =
        attempt.step === "reserve-signing-key"
          ? "com.atproto.server.reserveSigningKey"
          : attempt.step === "create-account"
            ? "com.atproto.server.createAccount"
            : undefined;
      if (
        !expectedMethod ||
        attempt.method !== expectedMethod ||
        attempt.state !== "acknowledged" ||
        ![reservation.target, reservation.public_target].includes(
          attempt.target,
        )
      )
        unmapped();
    }
  }
  if (
    attempts.some((attempt) => !byOperation.has(attempt.operation_id)) ||
    admissions.length !== 0
  )
    unmapped();
  const journals = new Map<string, string>();
  for (const row of states.filter(
    (entry) => entry.namespace === "operations",
  )) {
    const value = object(row.value);
    if (
      !only(value, [
        "id",
        "did",
        "kind",
        "phase",
        "at",
        "registrationIdentity",
        "authorityOperationId",
      ]) ||
      value.kind !== "create" ||
      value.phase !== "complete" ||
      !encodedDate(value.at) ||
      typeof value.did !== "string" ||
      row.key !== `create:${value.did}` ||
      value.id !== row.key ||
      typeof value.authorityOperationId !== "string" ||
      !byOperation.has(value.authorityOperationId) ||
      !accountsByDid.has(value.did) ||
      journals.has(value.authorityOperationId)
    )
      unmapped();
    if (value.registrationIdentity !== undefined) {
      if (
        !value.registrationIdentity ||
        typeof value.registrationIdentity !== "object" ||
        Array.isArray(value.registrationIdentity)
      )
        unmapped();
      const identity = value.registrationIdentity as Record<string, unknown>;
      if (
        !only(identity, ["kind", "userId", "email"]) ||
        identity.kind !== "better-auth" ||
        typeof identity.userId !== "string" ||
        typeof identity.email !== "string"
      )
        unmapped();
    }
    journals.set(value.authorityOperationId, value.did);
  }
  if (journals.size !== reservations.length) unmapped();
  const references = states.filter(
    (entry) => entry.namespace === "registration:host-references",
  );
  if (references.length !== reservations.length) unmapped();
  const referencesByDid = new Map(
    references.map((entry) => [entry.key, entry]),
  );
  for (const [operationId, did] of journals) {
    const reservation = byOperation.get(operationId);
    const account = accountsByDid.get(did);
    const row = referencesByDid.get(did);
    if (!reservation || !account || !row) unmapped();
    const reference = object(row.value);
    const data = object(account.data);
    if (
      !only(reference, [
        "operationId",
        "did",
        "hostId",
        "revision",
        "publicTarget",
        "internalTarget",
        "signedGenesis",
      ]) ||
      reference.operationId !== operationId ||
      reference.did !== did ||
      reference.hostId !== reservation.host_id ||
      reference.revision !== reservation.revision ||
      reference.publicTarget !== reservation.public_target ||
      reference.internalTarget !== reservation.target ||
      account.pds_id !== reservation.host_id ||
      data.did !== did ||
      data.pdsId !== reservation.host_id ||
      data.pdsRevision !== reservation.revision ||
      data.pdsUrl !== reservation.public_target
    )
      unmapped();
    let genesis;
    try {
      genesis = plc.def.operation.parse(reference.signedGenesis);
      await plc.assureValidOp(genesis);
      if ((await plc.didForCreateOp(genesis)) !== did) unmapped();
      await plc.assureValidSig(genesis.rotationKeys, genesis);
    } catch {
      unmapped();
    }
    const cid = String(await cidForCbor(genesis));
    const signedEvent = history.find(
      (event) =>
        event.operation_id === operationId &&
        event.kind === "signed" &&
        event.did === did &&
        event.cid === cid,
    );
    const stored = custodyByKey.get(JSON.stringify([did, cid]));
    const { sig: _signature, ...facts } = genesis;
    if (
      !signedEvent ||
      !stored ||
      canonicalJson(facts) !== stored.operation ||
      (data.op !== undefined &&
        canonicalJson(data.op) !== canonicalJson(genesis))
    )
      unmapped();
  }
  const signed = history.filter((event) => event.kind === "signed");
  for (const event of signed) {
    if (
      event.provenance !== "entryway-authorized" ||
      event.supporting_observation_id !== null ||
      !event.operation_id ||
      journals.get(event.operation_id) !== event.did
    )
      unmapped();
    const reservation = byOperation.get(event.operation_id);
    const record = custodyByKey.get(JSON.stringify([event.did, event.cid]));
    if (!reservation || !record) unmapped();
    const facts = object(record.operation);
    const services = facts.services;
    if (
      facts.prev !== null ||
      !services ||
      typeof services !== "object" ||
      Array.isArray(services)
    )
      unmapped();
    const pds = (services as Record<string, unknown>).atproto_pds;
    if (
      !pds ||
      typeof pds !== "object" ||
      Array.isArray(pds) ||
      (pds as Record<string, unknown>).endpoint !==
        registryProtectedResource(reservation.public_target, false)
    )
      unmapped();
  }
  if (
    signed.length !== reservations.length ||
    reservations.some(
      (reservation) =>
        signed.filter(
          (event) => event.operation_id === reservation.operation_id,
        ).length !== 1,
    ) ||
    custody.length !== signed.length ||
    custody.some(
      (row) =>
        !history.some(
          (event) => event.did === row.did && event.cid === row.cid,
        ),
    )
  )
    unmapped();
  for (const row of observations) {
    let observation;
    try {
      observation = validateCustodyObservation(object(row.value));
    } catch {
      unmapped();
    }
    if (
      observation.id !== row.id ||
      observation.did !== row.did ||
      observation.directory !== row.directory ||
      !observation.operationId ||
      journals.get(observation.operationId) !== row.did ||
      observation.entries.length !== 1 ||
      observation.entries[0]?.nullified ||
      observation.snapshot.tombstone
    )
      unmapped();
    const entry = observation.entries[0]!;
    const signedEvent = signed.find(
      (event) =>
        event.did === row.did &&
        event.cid === entry.cid &&
        event.operation_id === observation.operationId,
    );
    const record = custodyByKey.get(JSON.stringify([row.did, entry.cid]));
    if (
      !signedEvent ||
      !record ||
      canonicalJson(entry.operation) !== record.operation
    )
      unmapped();
    const observed = history.filter(
      (event) => event.supporting_observation_id === row.id,
    );
    if (
      observed.length !== 1 ||
      observed[0]?.kind !== "observed" ||
      observed[0].provenance !== "directory-observed-publication" ||
      observed[0].did !== row.did ||
      observed[0].cid !== entry.cid ||
      observed[0].operation_id !== observation.operationId
    )
      unmapped();
  }
  if (history.length !== signed.length + observations.length) unmapped();
  for (const row of inventories) {
    let inventory;
    try {
      inventory = validateCustodyInventory(object(row.value));
    } catch {
      unmapped();
    }
    if (inventory.did !== row.did || !inventory.observation) unmapped();
    const observed = observations.find(
      (item) =>
        item.id === inventory.observation?.eventId && item.did === row.did,
    );
    if (
      !observed ||
      canonicalJson(
        validateCustodyObservation(object(observed.value)).snapshot,
      ) !== canonicalJson(inventory.observation)
    )
      unmapped();
  }
  if (
    observations.some(
      (row) => !inventories.some((item) => item.did === row.did),
    )
  )
    unmapped();
  for (const row of states) {
    if (["operations", "registration:host-references"].includes(row.namespace))
      continue;
    if (row.namespace === "otp-limits") {
      let value: unknown;
      try {
        value = JSON.parse(row.value);
      } catch {
        unmapped();
      }
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
      )
        unmapped();
      continue;
    }
    const value = object(row.value);
    if (
      row.namespace === "browser" &&
      only(value, ["csrf", "createdAt"]) &&
      typeof value.csrf === "string" &&
      encodedDate(value.createdAt)
    )
      continue;
    if (
      row.namespace === "auth-flows" &&
      only(value, ["id", "deviceId", "createdAt"]) &&
      value.id === row.key &&
      typeof value.deviceId === "string" &&
      encodedDate(value.createdAt)
    )
      continue;
    if (
      row.namespace === "oauth:devices" &&
      only(value, ["ipAddress", "lastSeenAt", "sessionId", "userAgent"]) &&
      typeof value.sessionId === "string" &&
      typeof value.ipAddress === "string" &&
      typeof value.userAgent === "string" &&
      encodedDate(value.lastSeenAt)
    )
      continue;
    if (
      row.namespace === "oauth:device-accounts" &&
      only(value, [
        "createdAt",
        "updatedAt",
        "deviceId",
        "did",
        "membershipId",
      ]) &&
      typeof value.did === "string" &&
      typeof value.deviceId === "string" &&
      typeof value.membershipId === "string" &&
      encodedDate(value.createdAt) &&
      encodedDate(value.updatedAt) &&
      row.key === `${value.deviceId}/${value.did}` &&
      accountsByDid.has(value.did)
    )
      continue;
    if (
      row.namespace === "custody:refresh-pending" &&
      only(value, ["error", "operationId"]) &&
      value.error === "CustodyEvidenceUnavailable" &&
      typeof value.operationId === "string" &&
      journals.get(value.operationId) === row.key
    )
      continue;
    unmapped();
  }
}
