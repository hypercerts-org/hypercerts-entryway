import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import type { DatabaseExecutor } from "../executor.js";
import type { PdsCredentialRegistryStore } from "../pds-registry.port.js";
import type {
  PdsOutboundCheckStore,
  PdsOutboundReceipt,
} from "../pds-registry-checks.port.js";
import { assertFreshPdsEnrollment } from "./pds-registry-enrollment-guard.js";

function receiptSnapshot(receipt: PdsOutboundReceipt) {
  const {
    revision,
    direction,
    receiptId,
    generation,
    manifestFingerprint,
    verifierVersion,
    verifierPolicyFingerprint,
    verifierPolicyGeneration,
    observedAt,
    completedAt,
    expiresAt,
    expired,
    publicDidOk,
    internalDidOk,
    publicMetadataOk,
    internalMetadataOk,
    adminAttempted,
    adminOk,
    reason,
  } = receipt;
  return {
    revision,
    direction,
    receiptId,
    generation,
    manifestFingerprint,
    verifierVersion,
    verifierPolicyFingerprint,
    verifierPolicyGeneration,
    observedAt,
    completedAt,
    expiresAt,
    expired,
    publicDidOk,
    internalDidOk,
    publicMetadataOk,
    internalMetadataOk,
    adminAttempted,
    adminOk,
    reason,
  };
}
/** Shared live trust check for placement and outbound authentication. */
export async function hasPdsPolicyEvidence(
  db: DatabaseExecutor,
  hostId: string,
  revision: number,
  manifestFingerprint: string,
  policy: { generation: number; fingerprint: string },
): Promise<boolean> {
  const events = db.tables.pds_host_enrollment_events;
  const evidence = await db.read("pds_host_enrollment_events", {
    where: and(
      eq(events.host_id, hostId),
      eq(events.revision, revision),
      eq(events.policy_generation, policy.generation),
      or(eq(events.kind, "associate"), eq(events.kind, "reauthorize")),
    ),
    limit: 2,
  });
  const [event] = evidence;
  if (
    evidence.length !== 1 ||
    !event ||
    event.manifest_fingerprint !== manifestFingerprint
  )
    return false;
  try {
    const parsed: unknown = JSON.parse(event.receipt_snapshot);
    if (!parsed || typeof parsed !== "object") return false;
    const receipt = parsed as Record<string, unknown>;
    return (
      receipt.receiptId === event.receipt_id &&
      receipt.direction === "entryway-to-pds" &&
      receipt.verifierVersion === 1 &&
      receipt.generation === event.generation &&
      receipt.revision === revision &&
      receipt.manifestFingerprint === manifestFingerprint &&
      receipt.verifierPolicyGeneration === policy.generation &&
      receipt.verifierPolicyFingerprint === policy.fingerprint &&
      receipt.reason === "ok" &&
      receipt.publicDidOk === true &&
      receipt.internalDidOk === true &&
      receipt.publicMetadataOk === true &&
      receipt.internalMetadataOk === true &&
      receipt.adminAttempted === true &&
      receipt.adminOk === true
    );
  } catch {
    return false;
  }
}

type AttestInput = {
  revision: number;
  receiptId: string;
  idempotencyKey: string;
  emptyStock: true;
  manifestApplied: true;
  callbackCredentialApplied: true;
  restartedBeforeCheck: true;
};
type AssociateInput = {
  revision: number;
  attestationId: string;
  idempotencyKey: string;
};
type ReauthorizeInput = {
  revision: number;
  policyGeneration: number;
  receiptId: string;
  idempotencyKey: string;
};
export function createPdsEnrollment(
  db: DatabaseExecutor,
  registry: PdsCredentialRegistryStore,
  checks: PdsOutboundCheckStore,
) {
  const hosts = db.tables.pds_hosts,
    events = db.tables.pds_host_enrollment_events;
  async function replay(
    hostId: string,
    kind: string,
    key: string,
    request: string,
  ) {
    const [row] = await db.read("pds_host_enrollment_events", {
      where: and(
        eq(events.host_id, hostId),
        eq(events.kind, kind),
        eq(events.idempotency_key, key),
      ),
    });
    if (!row) return undefined;
    if (row.request !== request) throw new Error("PdsEnrollmentConflict");
    return JSON.parse(row.result) as Record<string, unknown>;
  }
  async function currentReceipt(
    hostId: string,
    revision: number,
    receiptId: string,
  ) {
    const manifest = await registry.readManifest(hostId, revision);
    if (!manifest || manifest.manifest.stagedIncomingMigration)
      throw new Error("PdsEnrollmentConflict");
    const receipt = (await checks.status(hostId)).last;
    const now = await db.databaseTime();
    if (
      !receipt ||
      receipt.receiptId !== receiptId ||
      receipt.revision !== revision ||
      receipt.expired ||
      receipt.expiresAt <= now ||
      receipt.manifestFingerprint !== manifest.fingerprint ||
      receipt.reason !== "ok" ||
      !receipt.publicDidOk ||
      !receipt.internalDidOk ||
      !receipt.publicMetadataOk ||
      !receipt.internalMetadataOk ||
      !receipt.adminAttempted ||
      !receipt.adminOk
    )
      throw new Error("PdsEnrollmentConflict");
    return { manifest, receipt, now };
  }
  async function current(hostId: string, revision: number, receiptId: string) {
    const [host] = await db.read("pds_hosts", { where: eq(hosts.id, hostId) });
    if (
      !host ||
      host.association !== "unassociated" ||
      host.active_revision !== null ||
      host.revision !== revision ||
      host.staged_revision !== revision
    )
      throw new Error("PdsEnrollmentConflict");
    const { manifest, receipt, now } = await currentReceipt(
      hostId,
      revision,
      receiptId,
    );
    const revisionValue = manifest.manifest;
    await assertFreshPdsEnrollment(db, {
      hostId,
      revision,
      serviceDid: revisionValue.serviceDid,
      publicUrl: revisionValue.publicUrl,
      internalUrl: revisionValue.internalUrl,
      stagedIncomingMigration: revisionValue.stagedIncomingMigration,
      order: revisionValue.order,
    });
    return { receipt, now };
  }
  return {
    async status(hostId: string) {
      return db.transact(async () => {
        const rows = await db.read("pds_host_enrollment_events", {
          where: and(eq(events.host_id, hostId), eq(events.kind, "attest")),
        });
        const attestation = rows.sort(
          (left, right) => right.created_at - left.created_at,
        )[0];
        if (!attestation) return null;
        const receipt = (await checks.status(hostId)).last;
        const now = await db.databaseTime();
        const associations = await db.read("pds_host_enrollment_events", {
          where: and(eq(events.host_id, hostId), eq(events.kind, "associate")),
        });
        const association = associations.sort(
          (left, right) => right.created_at - left.created_at,
        )[0];
        const [host] = await db.read("pds_hosts", {
          where: eq(hosts.id, hostId),
        });
        const consumed = await db.read("pds_host_enrollment_events", {
          where: and(
            eq(events.attestation_id, attestation.id),
            eq(events.kind, "associate"),
          ),
        });
        return {
          attestationId: attestation.id,
          revision: attestation.revision,
          receiptId: attestation.receipt_id,
          confirmed: "empty-stock-configuration",
          associationReceipt: association
            ? JSON.parse(association.receipt_snapshot)
            : null,
          createdAt: attestation.created_at,
          expiresAt: attestation.expires_at,
          usable: Boolean(
            host?.association === "unassociated" &&
            !consumed.length &&
            receipt &&
            !receipt.expired &&
            receipt.receiptId === attestation.receipt_id &&
            receipt.generation === attestation.generation &&
            receipt.verifierPolicyGeneration ===
              attestation.policy_generation &&
            receipt.manifestFingerprint === attestation.manifest_fingerprint &&
            attestation.expires_at > now,
          ),
        };
      });
    },
    async attest(hostId: string, input: AttestInput) {
      const request = JSON.stringify([
        input.revision,
        input.receiptId,
        input.emptyStock,
        input.manifestApplied,
        input.callbackCredentialApplied,
        input.restartedBeforeCheck,
      ]);
      return db.transact(async () => {
        const previous = await replay(
          hostId,
          "attest",
          input.idempotencyKey,
          request,
        );
        if (previous) return previous;
        if (
          input.emptyStock !== true ||
          input.manifestApplied !== true ||
          input.callbackCredentialApplied !== true ||
          input.restartedBeforeCheck !== true
        )
          throw new Error("PdsEnrollmentConflict");
        const { receipt, now } = await current(
          hostId,
          input.revision,
          input.receiptId,
        );
        const id = randomUUID();
        const result = {
          attestationId: id,
          hostId,
          revision: input.revision,
          receiptId: input.receiptId,
          expiresAt: receipt.expiresAt,
          association: "unassociated",
          inbound: "unproven",
        };
        await db.insert("pds_host_enrollment_events", {
          id,
          host_id: hostId,
          revision: input.revision,
          kind: "attest",
          principal_class: "global-admin",
          idempotency_key: input.idempotencyKey,
          request,
          receipt_id: input.receiptId,
          attestation_id: id,
          generation: receipt.generation,
          policy_generation: receipt.verifierPolicyGeneration,
          manifest_fingerprint: receipt.manifestFingerprint,
          receipt_snapshot: JSON.stringify(receiptSnapshot(receipt)),
          expires_at: receipt.expiresAt,
          created_at: now,
          result: JSON.stringify(result),
        });
        return result;
      });
    },
    async reauthorize(hostId: string, input: ReauthorizeInput) {
      const { revision, policyGeneration, receiptId, idempotencyKey } = input;
      const request = JSON.stringify([revision, policyGeneration, receiptId]);
      return db.transact(async () => {
        const previous = await replay(
          hostId,
          "reauthorize",
          idempotencyKey,
          request,
        );
        if (previous) return previous;
        const modes = await db.read("authority_mode", { limit: 2 });
        if (
          modes.length !== 1 ||
          modes[0]?.id !== 1 ||
          modes[0].mode !== "registry-bootstrap"
        )
          throw new Error("PdsEnrollmentModeConflict");
        const [host] = await db.read("pds_hosts", {
          where: eq(hosts.id, hostId),
        });
        if (
          !host ||
          host.association !== "associated" ||
          host.lifecycle === "retired" ||
          host.revision !== revision ||
          host.active_revision !== revision ||
          host.staged_revision !== revision
        )
          throw new Error("PdsEnrollmentConflict");
        const { manifest, receipt, now } = await currentReceipt(
          hostId,
          revision,
          receiptId,
        );
        const scope = and(
          eq(events.host_id, hostId),
          eq(events.revision, revision),
        )!;
        const [association] = await db.read("pds_host_enrollment_events", {
          where: and(scope, eq(events.kind, "associate")),
        });
        if (
          !association ||
          association.manifest_fingerprint !== manifest.fingerprint ||
          receipt.verifierPolicyGeneration !== policyGeneration ||
          association.policy_generation >= policyGeneration
        )
          throw new Error("PdsEnrollmentConflict");
        const [existing] = await db.read("pds_host_enrollment_events", {
          where: and(
            scope,
            eq(events.kind, "reauthorize"),
            eq(events.policy_generation, policyGeneration),
          ),
        });
        if (existing) throw new Error("PdsEnrollmentConflict");
        const result = { hostId, revision, policyGeneration, receiptId };
        await db.insert("pds_host_enrollment_events", {
          id: randomUUID(),
          host_id: hostId,
          revision,
          kind: "reauthorize",
          principal_class: "global-admin",
          idempotency_key: idempotencyKey,
          request,
          receipt_id: receiptId,
          attestation_id: association.attestation_id,
          generation: receipt.generation,
          policy_generation: policyGeneration,
          manifest_fingerprint: manifest.fingerprint,
          receipt_snapshot: JSON.stringify(receiptSnapshot(receipt)),
          expires_at: receipt.expiresAt,
          created_at: now,
          result: JSON.stringify(result),
        });
        return result;
      });
    },
    async associate(hostId: string, input: AssociateInput) {
      const request = JSON.stringify([input.revision, input.attestationId]);
      return db.transact(async () => {
        const previous = await replay(
          hostId,
          "associate",
          input.idempotencyKey,
          request,
        );
        if (previous) return previous;
        const [attestation] = await db.read("pds_host_enrollment_events", {
          where: and(
            eq(events.id, input.attestationId),
            eq(events.kind, "attest"),
            eq(events.host_id, hostId),
          ),
        });
        if (!attestation || attestation.revision !== input.revision)
          throw new Error("PdsEnrollmentConflict");
        const prior = await db.read("pds_host_enrollment_events", {
          where: and(
            eq(events.attestation_id, input.attestationId),
            eq(events.kind, "associate"),
          ),
        });
        if (prior.length) throw new Error("PdsEnrollmentConflict");
        const { receipt, now } = await current(
          hostId,
          input.revision,
          attestation.receipt_id,
        );
        if (
          attestation.expires_at <= now ||
          attestation.generation !== receipt.generation ||
          attestation.policy_generation !== receipt.verifierPolicyGeneration ||
          attestation.manifest_fingerprint !== receipt.manifestFingerprint
        )
          throw new Error("PdsEnrollmentConflict");
        const changed = await db.update(
          "pds_hosts",
          { association: "associated", active_revision: input.revision },
          and(
            eq(hosts.id, hostId),
            eq(hosts.revision, input.revision),
            eq(hosts.association, "unassociated"),
          )!,
        );
        if (changed !== 1) throw new Error("PdsEnrollmentConflict");
        const result = {
          hostId,
          revision: input.revision,
          attestationId: input.attestationId,
          association: "associated",
          lifecycle: "disabled",
          inbound: "unproven",
        };
        await db.insert("pds_host_enrollment_events", {
          id: randomUUID(),
          host_id: hostId,
          revision: input.revision,
          kind: "associate",
          principal_class: "global-admin",
          idempotency_key: input.idempotencyKey,
          request,
          receipt_id: receipt.receiptId,
          attestation_id: input.attestationId,
          generation: receipt.generation,
          policy_generation: receipt.verifierPolicyGeneration,
          manifest_fingerprint: receipt.manifestFingerprint,
          receipt_snapshot: JSON.stringify(receiptSnapshot(receipt)),
          expires_at: receipt.expiresAt,
          created_at: now,
          result: JSON.stringify(result),
        });
        return result;
      });
    },
  };
}
