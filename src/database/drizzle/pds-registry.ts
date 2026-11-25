import { and, asc, eq } from "drizzle-orm";
import type { DatabaseExecutor, StoredRow } from "../executor.js";
import type {
  PdsHost,
  PdsHostConfiguration,
  PdsHostRevision,
  PdsRegistryStore,
} from "../pds-registry.port.js";

function host(row: StoredRow<"pds_hosts">): PdsHost {
  if (
    row.association !== "unassociated" ||
    row.lifecycle !== "disabled" ||
    row.staged_revision === null
  )
    throw new Error("InvalidPdsHostState");
  return {
    hostId: row.id,
    revision: row.revision,
    order: row.configured_order,
    association: row.association,
    lifecycle: row.lifecycle,
    activeRevision: row.active_revision,
    stagedRevision: row.staged_revision,
  };
}
function revision(row: StoredRow<"pds_host_revisions">): PdsHostRevision {
  return {
    hostId: row.host_id,
    revision: row.revision,
    serviceDid: row.service_did,
    publicUrl: row.public_url,
    internalUrl: row.internal_url,
    order: row.configured_order,
  };
}
function normalize(input: PdsHostConfiguration): PdsHostConfiguration {
  if (!input.hostId || !input.serviceDid || !Number.isSafeInteger(input.order))
    throw new Error("InvalidPdsHost");
  const urls = [input.publicUrl, input.internalUrl].map((value) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("InvalidPdsHostUrl");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("InvalidPdsHostUrl");
    return parsed.toString();
  });
  return {
    hostId: input.hostId,
    serviceDid: input.serviceDid,
    publicUrl: urls[0]!,
    internalUrl: urls[1]!,
    order: input.order,
  };
}
export function createPdsRegistry(db: DatabaseExecutor): PdsRegistryStore {
  const hosts = db.tables.pds_hosts,
    revisions = db.tables.pds_host_revisions,
    requests = db.tables.pds_host_stage_requests;
  async function readHostRevision(hostId: string, version: number) {
    const rows = await db.read("pds_host_revisions", {
      where: and(
        eq(revisions.host_id, hostId),
        eq(revisions.revision, version),
      ),
    });
    return rows[0] && revision(rows[0]);
  }
  return {
    async stageHost(input, expectedRevision, idempotencyKey) {
      const value = normalize(input);
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        expectedRevision === Number.MAX_SAFE_INTEGER ||
        !idempotencyKey
      )
        throw new Error("InvalidPdsHostRequest");
      const request = JSON.stringify({ ...value, expectedRevision });
      return db.transact(async () => {
        const replay = async () => {
          const rows = await db.read("pds_host_stage_requests", {
            where: and(
              eq(requests.host_id, value.hostId),
              eq(requests.idempotency_key, idempotencyKey),
            ),
          });
          if (!rows[0]) return undefined;
          if (rows[0].request !== request)
            throw new Error("PdsHostIdempotencyConflict");
          const prior = await readHostRevision(value.hostId, rows[0].revision);
          if (!prior) throw new Error("InvalidPdsHostRequestState");
          return prior;
        };
        const prior = await replay();
        if (prior) return prior;
        if (expectedRevision === 0)
          await db.insert(
            "pds_hosts",
            {
              id: value.hostId,
              revision: 0,
              configured_order: value.order,
              association: "unassociated",
              lifecycle: "disabled",
              active_revision: null,
              staged_revision: null,
            },
            { ignoreConflict: true },
          );
        const next = expectedRevision + 1;
        const changed = await db.update(
          "pds_hosts",
          {
            revision: next,
            configured_order: value.order,
            staged_revision: next,
          },
          and(
            eq(hosts.id, value.hostId),
            eq(hosts.revision, expectedRevision),
          )!,
        );
        if (!changed) {
          const retried = await replay();
          if (retried) return retried;
          throw new Error("PdsHostRevisionConflict");
        }
        // A concurrent request may have committed this key while the host update waited.
        // Rechecking under the host write lock turns key reuse into a stable conflict.
        const concurrent = await replay();
        if (concurrent) throw new Error("PdsHostIdempotencyConflict");
        await db.insert("pds_host_revisions", {
          host_id: value.hostId,
          revision: next,
          service_did: value.serviceDid,
          public_url: value.publicUrl,
          internal_url: value.internalUrl,
          configured_order: value.order,
        });
        await db.insert("pds_host_stage_requests", {
          host_id: value.hostId,
          idempotency_key: idempotencyKey,
          request,
          revision: next,
        });
        return { ...value, revision: next };
      });
    },
    async readHost(hostId) {
      const rows = await db.read("pds_hosts", { where: eq(hosts.id, hostId) });
      return rows[0] && host(rows[0]);
    },
    async listHosts() {
      return (
        await db.read("pds_hosts", {
          orderBy: [asc(hosts.configured_order), asc(hosts.id)],
        })
      ).map(host);
    },
    readHostRevision,
  };
}
