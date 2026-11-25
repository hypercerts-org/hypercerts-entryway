import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../executor.js";
import type { PdsOutboundCheckStore } from "../pds-registry-checks.port.js";

const CHECK_LEASE_MS = 30_000;
export function createPdsOutboundCheckStore(
  db: DatabaseExecutor,
): PdsOutboundCheckStore {
  const hosts = db.tables.pds_hosts,
    revisions = db.tables.pds_host_revisions,
    checks = db.tables.pds_host_checks;
  return {
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
        const [revision] = await db.read("pds_host_revisions", {
          where: and(
            eq(revisions.host_id, hostId),
            eq(revisions.revision, expectedRevision),
          ),
        });
        if (!revision) throw new Error("PdsHostRevisionConflict");
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
        const attemptId = randomUUID();
        if (existing)
          await db.update(
            "pds_host_checks",
            {
              attempt_id: attemptId,
              attempt_revision: expectedRevision,
              expires_at: now + CHECK_LEASE_MS,
              started_at: now,
              last_revision: null,
              observed_at: null,
              public_did_ok: null,
              internal_did_ok: null,
              public_metadata_ok: null,
              internal_metadata_ok: null,
              admin_attempted: null,
              admin_ok: null,
              reason: null,
            },
            eq(checks.host_id, hostId),
          );
        else
          await db.insert("pds_host_checks", {
            host_id: hostId,
            attempt_id: attemptId,
            attempt_revision: expectedRevision,
            expires_at: now + CHECK_LEASE_MS,
            started_at: now,
            last_revision: null,
            observed_at: null,
            public_did_ok: null,
            internal_did_ok: null,
            public_metadata_ok: null,
            internal_metadata_ok: null,
            admin_attempted: null,
            admin_ok: null,
            reason: null,
          });
        return {
          attemptId,
          revision: {
            hostId,
            revision: revision.revision,
            serviceDid: revision.service_did,
            publicUrl: revision.public_url,
            internalUrl: revision.internal_url,
            order: revision.configured_order,
          },
        };
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
          state.expires_at <= now
        )
          throw new Error("PdsHostRevisionConflict");
        const changed = await db.update(
          "pds_host_checks",
          {
            attempt_id: null,
            attempt_revision: null,
            expires_at: null,
            last_revision: revision,
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
        return { ...observation, revision, observedAt: state.started_at };
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
          state.last_revision !== host.revision ||
          state.last_revision === null ||
          state.observed_at === null ||
          state.public_did_ok === null ||
          state.internal_did_ok === null ||
          state.public_metadata_ok === null ||
          state.internal_metadata_ok === null ||
          state.admin_attempted === null ||
          state.admin_ok === null ||
          !state.reason
        )
          return { pending, last: null };
        const allowed = [
          "ok",
          "target-not-allowed",
          "network-error",
          "unexpected-status",
          "invalid-response",
          "did-mismatch",
          "metadata-mismatch",
          "admin-rejected",
        ];
        if (!allowed.includes(state.reason))
          throw new Error("InvalidPdsCheckState");
        return {
          pending,
          last: {
            revision: state.last_revision,
            observedAt: state.observed_at,
            publicDidOk: state.public_did_ok,
            internalDidOk: state.internal_did_ok,
            publicMetadataOk: state.public_metadata_ok,
            internalMetadataOk: state.internal_metadata_ok,
            adminAttempted: state.admin_attempted,
            adminOk: state.admin_ok,
            reason:
              state.reason as import("../pds-registry-checks.port.js").PdsCheckReason,
          },
        };
      });
    },
  };
}
