import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { hasPdsPolicyEvidence } from "./pds-registry-enrollment.js";
import type { DatabaseExecutor, StoredRow } from "../executor.js";
import type { PdsLifecycleStore } from "../pds-lifecycle.port.js";
import type { PdsHealthStore } from "../pds-health.port.js";
import type {
  PdsHost,
  PdsHostRevision,
  PdsRegistryStore,
  PdsCredentialRegistryStore,
} from "../pds-registry.port.js";
import {
  pdsRegistryManifest,
  type PdsRegistryPublicTrust,
} from "../pds-registry-manifest.js";
import {
  assertNoPdsAuthorityReferences,
  assertNoPdsHostReferences,
} from "./pds-registry-enrollment-guard.js";

export function createPdsLifecycle(
  db: DatabaseExecutor,
  registry: PdsRegistryStore & PdsCredentialRegistryStore,
  health: PdsHealthStore,
  publicTrust: () => PdsRegistryPublicTrust,
  verifierPolicy: (revision: PdsHostRevision) => string | undefined,
): PdsLifecycleStore {
  const hosts = db.tables.pds_hosts,
    policies = db.tables.pds_host_verifier_policies,
    commands = db.tables.pds_host_lifecycle_events;
  async function requireMode() {
    const modes = await db.read("authority_mode");
    if (
      modes.length !== 1 ||
      modes[0]?.id !== 1 ||
      modes[0].mode !== "registry-bootstrap"
    )
      throw new Error("PdsLifecycleModeConflict");
  }
  async function trusted(row: StoredRow<"pds_hosts">): Promise<boolean> {
    if (
      row.association !== "associated" ||
      row.active_revision === null ||
      row.active_revision !== row.revision
    )
      return false;
    const revision = await registry.readHostRevision(
      row.id,
      row.active_revision,
    );
    const saved = await registry.readManifest(row.id, row.active_revision);
    if (!revision || !saved) return false;
    const current = pdsRegistryManifest(revision, publicTrust());
    if (
      saved.fingerprint !== current.fingerprint ||
      JSON.stringify(saved.manifest) !== JSON.stringify(current.manifest)
    )
      return false;
    const [policy] = await db.read("pds_host_verifier_policies", {
      where: eq(policies.host_id, row.id),
    });
    if (
      !policy ||
      policy.revision !== row.active_revision ||
      policy.fingerprint !== verifierPolicy(revision)
    )
      return false;
    return hasPdsPolicyEvidence(
      db,
      row.id,
      row.active_revision,
      saved.fingerprint,
      policy,
    );
  }
  async function eligible(
    row: StoredRow<"pds_hosts">,
    requireBothPass: boolean,
  ): Promise<boolean> {
    if (!(await trusted(row))) return false;
    const status = await health.status(row.id);
    return Boolean(
      status &&
      status.revision === row.active_revision &&
      status.fresh &&
      status.state === "healthy" &&
      (!requireBothPass || (status.publicOk && status.internalOk)),
    );
  }
  async function readHost(id: string): Promise<PdsHost> {
    const result = await registry.readHost(id);
    if (!result) throw new Error("PdsLifecycleConflict");
    return result;
  }
  return {
    async hasTrustedAssociation() {
      return db.transact(async () => {
        await requireMode();
        for (const host of await db.read("pds_hosts")) {
          if (host.lifecycle !== "retired" && (await trusted(host)))
            return true;
        }
        return false;
      });
    },
    async transition(
      hostId,
      command,
      expectedRevision,
      expectedLifecycleVersion,
      commandKey,
    ) {
      if (
        !["enable", "drain", "retire"].includes(command) ||
        !hostId ||
        !commandKey ||
        commandKey.length > 128 ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 1 ||
        !Number.isSafeInteger(expectedLifecycleVersion) ||
        expectedLifecycleVersion < 0 ||
        expectedLifecycleVersion >= Number.MAX_SAFE_INTEGER
      )
        throw new Error("InvalidPdsLifecycleRequest");
      const request = JSON.stringify([
        command,
        expectedRevision,
        expectedLifecycleVersion,
      ]);
      return db.transact(async () => {
        await requireMode();
        const [prior] = await db.read("pds_host_lifecycle_events", {
          where: and(
            eq(commands.host_id, hostId),
            eq(commands.command_key, commandKey),
          ),
        });
        if (prior) {
          if (prior.request !== request)
            throw new Error("PdsLifecycleConflict");
          return JSON.parse(prior.result) as PdsHost;
        }
        const [host] = await db.read("pds_hosts", {
          where: eq(hosts.id, hostId),
        });
        if (
          !host ||
          host.association !== "associated" ||
          host.revision !== expectedRevision ||
          host.active_revision !== expectedRevision ||
          host.lifecycle_version !== expectedLifecycleVersion
        )
          throw new Error("PdsLifecycleConflict");
        let next: PdsHost["lifecycle"];
        if (command === "enable") {
          if (
            !["disabled", "draining"].includes(host.lifecycle) ||
            !(await eligible(host, true))
          )
            throw new Error("PdsLifecycleIneligible");
          next = "enabled";
        } else if (command === "drain") {
          if (host.lifecycle !== "enabled")
            throw new Error("PdsLifecycleConflict");
          next = "draining";
        } else {
          if (!["disabled", "draining"].includes(host.lifecycle))
            throw new Error("PdsLifecycleConflict");
          const phases = await db.read("authority_phase");
          const phase = phases.length === 1 ? phases[0] : undefined;
          if (
            phase?.id === 1 &&
            phase.phase === "bootstrap" &&
            phase.generation === 1
          )
            await assertNoPdsAuthorityReferences(db, true);
          else if (
            phase?.id === 1 &&
            phase.phase === "registry-serving" &&
            phase.generation === 2
          )
            await assertNoPdsHostReferences(db, hostId);
          else throw new Error("PdsLifecycleModeConflict");
          next = "retired";
        }
        const changed = await db.update(
          "pds_hosts",
          { lifecycle: next, lifecycle_version: expectedLifecycleVersion + 1 },
          and(
            eq(hosts.id, hostId),
            eq(hosts.revision, expectedRevision),
            eq(hosts.lifecycle_version, expectedLifecycleVersion),
          )!,
        );
        if (changed !== 1) throw new Error("PdsLifecycleConflict");
        const result = await readHost(hostId);
        await db.insert("pds_host_lifecycle_events", {
          id: randomUUID(),
          host_id: hostId,
          command_key: commandKey,
          request,
          result: JSON.stringify(result),
          created_at: await db.databaseTime(),
        });
        return result;
      });
    },
    async candidates(requestedHostId) {
      if (
        requestedHostId !== undefined &&
        (typeof requestedHostId !== "string" || !requestedHostId)
      )
        throw new Error("PdsLifecycleIneligible");
      return db.transact(async () => {
        await requireMode();
        const rows = await db.read("pds_hosts", {
          orderBy: [asc(hosts.configured_order), asc(hosts.id)],
        });
        const selected: PdsHost[] = [];
        for (const row of rows) {
          if (requestedHostId && row.id !== requestedHostId) continue;
          if (row.lifecycle === "enabled" && (await eligible(row, false)))
            selected.push(await readHost(row.id));
        }
        if (requestedHostId && !selected.length)
          throw new Error("PdsLifecycleIneligible");
        return selected;
      });
    },
  };
}
