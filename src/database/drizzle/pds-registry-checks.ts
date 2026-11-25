import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DatabaseExecutor, StoredRow } from "../executor.js";
import type { PdsHostRevision } from "../pds-registry.port.js";
import {
  pdsRegistryManifest,
  type PdsRegistryPublicTrust,
} from "../pds-registry-manifest.js";
import type {
  PdsCheckReason,
  PdsOutboundCheckStore,
} from "../pds-registry-checks.port.js";

const CHECK_LEASE_MS = 30_000;
const RECEIPT_LIFETIME_MS = 600_000;
function revisionFrom(row: StoredRow<"pds_host_revisions">) {
  return {
    hostId: row.host_id,
    revision: row.revision,
    serviceDid: row.service_did,
    publicUrl: row.public_url,
    internalUrl: row.internal_url,
    order: row.configured_order,
    stagedIncomingMigration: row.staged_incoming_migration,
  };
}
export function createPdsOutboundCheckStore(
  db: DatabaseExecutor,
  publicTrust: () => PdsRegistryPublicTrust,
  verifierPolicy: (revision: PdsHostRevision) => string | undefined,
): PdsOutboundCheckStore {
  const hosts = db.tables.pds_hosts,
    revisions = db.tables.pds_host_revisions,
    checks = db.tables.pds_host_checks,
    manifests = db.tables.pds_host_manifests,
    policies = db.tables.pds_host_verifier_policies;
  async function currentManifest(hostId: string, version: number) {
    const [row] = await db.read("pds_host_revisions", {
      where: and(
        eq(revisions.host_id, hostId),
        eq(revisions.revision, version),
      ),
    });
    const [saved] = await db.read("pds_host_manifests", {
      where: and(
        eq(manifests.host_id, hostId),
        eq(manifests.revision, version),
      ),
    });
    if (!row || !saved) throw new Error("PdsHostRevisionConflict");
    const revision = revisionFrom(row),
      expected = pdsRegistryManifest(revision, publicTrust());
    if (
      saved.fingerprint !== expected.fingerprint ||
      saved.manifest !== JSON.stringify(expected.manifest)
    )
      throw new Error("PdsHostRevisionConflict");
    return { revision, fingerprint: expected.fingerprint };
  }
  return {
    async policyStatus(hostId) {
      return db.transact(async () => {
        const [host] = await db.read("pds_hosts", {
          where: eq(hosts.id, hostId),
        });
        if (!host || host.staged_revision === null)
          throw new Error("PdsHostRevisionConflict");
        const { revision } = await currentManifest(
          hostId,
          host.staged_revision,
        );
        const fingerprint = verifierPolicy(revision);
        const [policy] = await db.read("pds_host_verifier_policies", {
          where: eq(policies.host_id, hostId),
        });
        return {
          current: policy
            ? {
                revision: policy.revision,
                generation: policy.generation,
                fingerprint: policy.fingerprint,
              }
            : null,
          intended: fingerprint
            ? { revision: revision.revision, fingerprint }
            : null,
        };
      });
    },
    async transitionPolicy(
      hostId,
      version,
      expectedGeneration,
      intendedFingerprint,
    ) {
      return db.transact(async () => {
        const [host] = await db.read("pds_hosts", {
          where: eq(hosts.id, hostId),
        });
        if (
          !host ||
          host.revision !== version ||
          host.staged_revision !== version
        )
          throw new Error("PdsHostRevisionConflict");
        const { revision } = await currentManifest(hostId, version);
        const fingerprint = verifierPolicy(revision);
        if (!fingerprint) throw new Error("PdsVerifierUnavailable");
        if (fingerprint !== intendedFingerprint)
          throw new Error("PdsVerifierPolicyConflict");
        const [policy] = await db.read("pds_host_verifier_policies", {
          where: eq(policies.host_id, hostId),
        });
        if ((policy?.generation ?? 0) !== expectedGeneration)
          throw new Error("PdsVerifierPolicyConflict");
        if (
          policy &&
          policy.revision === version &&
          policy.fingerprint === fingerprint
        )
          return {
            revision: version,
            generation: policy.generation,
            fingerprint,
          };
        const generation = expectedGeneration + 1;
        if (!Number.isSafeInteger(generation))
          throw new Error("PdsVerifierPolicyConflict");
        if (policy)
          await db.update(
            "pds_host_verifier_policies",
            { revision: version, generation, fingerprint },
            eq(policies.host_id, hostId),
          );
        else
          await db.insert("pds_host_verifier_policies", {
            host_id: hostId,
            revision: version,
            generation,
            fingerprint,
          });
        await db.update(
          "pds_host_checks",
          {
            attempt_id: null,
            attempt_revision: null,
            expires_at: null,
            last_revision: null,
            last_receipt_id: null,
          },
          eq(checks.host_id, hostId),
        );
        return { revision: version, generation, fingerprint };
      });
    },
    async begin(hostId, expectedRevision) {
      return db.transact(async () => {
        const [host] = await db.read("pds_hosts", {
          where: eq(hosts.id, hostId),
        });
        if (
          !host ||
          host.revision !== expectedRevision ||
          host.staged_revision !== expectedRevision
        )
          throw new Error("PdsHostRevisionConflict");
        const { revision, fingerprint } = await currentManifest(
          hostId,
          expectedRevision,
        );
        const policyFingerprint = verifierPolicy(revision);
        if (!policyFingerprint) throw new Error("PdsVerifierUnavailable");
        let [policy] = await db.read("pds_host_verifier_policies", {
          where: eq(policies.host_id, hostId),
        });
        if (!policy) {
          await db.insert("pds_host_verifier_policies", {
            host_id: hostId,
            revision: expectedRevision,
            generation: 1,
            fingerprint: policyFingerprint,
          });
          [policy] = await db.read("pds_host_verifier_policies", {
            where: eq(policies.host_id, hostId),
          });
        }
        if (
          !policy ||
          policy.revision !== expectedRevision ||
          policy.fingerprint !== policyFingerprint
        )
          throw new Error("PdsVerifierPolicyConflict");
        const now = await db.databaseTime();
        const [existing] = await db.read("pds_host_checks", {
          where: eq(checks.host_id, hostId),
        });
        if (
          existing?.attempt_id &&
          existing.expires_at !== null &&
          existing.expires_at > now
        )
          throw new Error("PdsCheckPending");
        const generation = (existing?.generation ?? 0) + 1;
        if (!Number.isSafeInteger(generation))
          throw new Error("InvalidPdsCheckState");
        const attemptId = randomUUID();
        const values = {
          attempt_id: attemptId,
          generation,
          attempt_revision: expectedRevision,
          expires_at: now + CHECK_LEASE_MS,
          started_at: now,
          last_revision: null,
          last_receipt_id: null,
          manifest_fingerprint: fingerprint,
          verifier_version: 1,
          verifier_policy_fingerprint: policyFingerprint,
          verifier_policy_generation: policy.generation,
          completed_at: null,
          receipt_expires_at: null,
          observed_at: null,
          public_did_ok: null,
          internal_did_ok: null,
          public_metadata_ok: null,
          internal_metadata_ok: null,
          admin_attempted: null,
          admin_ok: null,
          reason: null,
        };
        if (existing)
          await db.update(
            "pds_host_checks",
            values,
            eq(checks.host_id, hostId),
          );
        else await db.insert("pds_host_checks", { host_id: hostId, ...values });
        return { attemptId, revision };
      });
    },
    async complete(hostId, revision, attemptId, observation) {
      return db.transact(async () => {
        const [host] = await db.read("pds_hosts", {
          where: eq(hosts.id, hostId),
        });
        const [state] = await db.read("pds_host_checks", {
          where: eq(checks.host_id, hostId),
        });
        const now = await db.databaseTime();
        if (
          !host ||
          host.revision !== revision ||
          host.staged_revision !== revision ||
          !state ||
          state.attempt_id !== attemptId ||
          state.attempt_revision !== revision ||
          state.expires_at === null ||
          state.started_at === null ||
          state.expires_at <= now ||
          state.started_at + RECEIPT_LIFETIME_MS <= now
        )
          throw new Error("PdsHostRevisionConflict");
        const { fingerprint, revision: currentRevision } =
          await currentManifest(hostId, revision);
        const [policy] = await db.read("pds_host_verifier_policies", {
          where: eq(policies.host_id, hostId),
        });
        if (
          !policy ||
          policy.revision !== revision ||
          policy.generation !== state.verifier_policy_generation ||
          policy.fingerprint !== state.verifier_policy_fingerprint
        )
          throw new Error("PdsVerifierPolicyConflict");
        if (
          state.manifest_fingerprint !== fingerprint ||
          state.verifier_version !== 1 ||
          !state.verifier_policy_fingerprint ||
          state.verifier_policy_fingerprint !== verifierPolicy(currentRevision)
        )
          throw new Error("PdsHostRevisionConflict");
        const receipt = {
          ...observation,
          revision,
          direction: "entryway-to-pds" as const,
          receiptId: attemptId,
          generation: state.generation,
          manifestFingerprint: fingerprint,
          verifierVersion: 1,
          verifierPolicyFingerprint: state.verifier_policy_fingerprint,
          verifierPolicyGeneration: policy.generation,
          observedAt: state.started_at,
          completedAt: now,
          expiresAt: state.started_at + RECEIPT_LIFETIME_MS,
          expired: false,
        };
        const changed = await db.update(
          "pds_host_checks",
          {
            attempt_id: null,
            attempt_revision: null,
            expires_at: null,
            last_revision: revision,
            last_receipt_id: attemptId,
            completed_at: now,
            receipt_expires_at: receipt.expiresAt,
            observed_at: state.started_at,
            public_did_ok: observation.publicDidOk,
            internal_did_ok: observation.internalDidOk,
            public_metadata_ok: observation.publicMetadataOk,
            internal_metadata_ok: observation.internalMetadataOk,
            admin_attempted: observation.adminAttempted,
            admin_ok: observation.adminOk,
            reason: observation.reason,
          },
          and(eq(checks.host_id, hostId), eq(checks.attempt_id, attemptId))!,
        );
        if (changed !== 1) throw new Error("PdsHostRevisionConflict");
        return receipt;
      });
    },
    async status(hostId) {
      return db.transact(async () => {
        const [state] = await db.read("pds_host_checks", {
          where: eq(checks.host_id, hostId),
        });
        const [host] = await db.read("pds_hosts", {
          where: eq(hosts.id, hostId),
        });
        const now = await db.databaseTime();
        const pending = Boolean(
          state?.attempt_id &&
          state.expires_at !== null &&
          state.expires_at > now,
        );
        if (
          !state ||
          !host ||
          state.last_revision === null ||
          state.last_revision !== host.revision ||
          !state.last_receipt_id ||
          !state.manifest_fingerprint ||
          state.verifier_version !== 1 ||
          !state.verifier_policy_fingerprint ||
          state.verifier_policy_generation === null ||
          state.observed_at === null ||
          state.completed_at === null ||
          state.receipt_expires_at === null ||
          state.public_did_ok === null ||
          state.internal_did_ok === null ||
          state.public_metadata_ok === null ||
          state.internal_metadata_ok === null ||
          state.admin_attempted === null ||
          state.admin_ok === null ||
          !state.reason
        )
          return { pending, last: null };
        const [policy] = await db.read("pds_host_verifier_policies", {
          where: eq(policies.host_id, hostId),
        });
        if (
          !policy ||
          policy.revision !== state.last_revision ||
          policy.generation !== state.verifier_policy_generation ||
          policy.fingerprint !== state.verifier_policy_fingerprint
        )
          return { pending: false, last: null };
        try {
          const current = await currentManifest(hostId, state.last_revision);
          if (
            current.fingerprint !== state.manifest_fingerprint ||
            state.verifier_policy_fingerprint !==
              verifierPolicy(current.revision)
          )
            return { pending, last: null };
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "PdsHostRevisionConflict"
          )
            return { pending, last: null };
          throw error;
        }
        const allowed: PdsCheckReason[] = [
          "ok",
          "target-not-allowed",
          "network-error",
          "unexpected-status",
          "invalid-response",
          "did-mismatch",
          "metadata-mismatch",
          "admin-rejected",
        ];
        if (!allowed.includes(state.reason as PdsCheckReason))
          throw new Error("InvalidPdsCheckState");
        return {
          pending,
          last: {
            revision: state.last_revision,
            direction: "entryway-to-pds" as const,
            receiptId: state.last_receipt_id,
            generation: state.generation,
            manifestFingerprint: state.manifest_fingerprint,
            verifierVersion: 1,
            verifierPolicyFingerprint: state.verifier_policy_fingerprint,
            verifierPolicyGeneration: policy.generation,
            observedAt: state.observed_at,
            completedAt: state.completed_at,
            expiresAt: state.receipt_expires_at,
            expired: now >= state.receipt_expires_at,
            publicDidOk: state.public_did_ok,
            internalDidOk: state.internal_did_ok,
            publicMetadataOk: state.public_metadata_ok,
            internalMetadataOk: state.internal_metadata_ok,
            adminAttempted: state.admin_attempted,
            adminOk: state.admin_ok,
            reason: state.reason as PdsCheckReason,
          },
        };
      });
    },
  };
}
