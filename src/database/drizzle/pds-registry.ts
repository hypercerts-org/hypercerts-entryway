import { and, asc, eq } from "drizzle-orm";
import { assertNoAssociatedPdsAlias } from "./pds-registry-enrollment-guard.js";
import type { DatabaseExecutor, StoredRow } from "../executor.js";
import {
  pdsRegistryManifest,
  type PdsRegistryPublicTrust,
} from "../pds-registry-manifest.js";
import {
  decryptPdsCredential,
  encryptPdsCredential,
  equalPdsDigest,
  pdsInboundDigest,
  pdsStageDigest,
  type PdsRegistryKeyring,
} from "../pds-registry-crypto.js";
import type {
  PdsHost,
  PdsHostConfiguration,
  PdsHostRevision,
  PdsRegistryStore,
  PdsCredentialRegistryStore,
} from "../pds-registry.port.js";

function host(row: StoredRow<"pds_hosts">): PdsHost {
  if (
    !["unassociated", "associated"].includes(row.association) ||
    row.lifecycle !== "disabled" ||
    row.staged_revision === null
  )
    throw new Error("InvalidPdsHostState");
  return {
    hostId: row.id,
    revision: row.revision,
    order: row.configured_order,
    association: row.association as "unassociated" | "associated",
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
    stagedIncomingMigration: row.staged_incoming_migration,
    order: row.configured_order,
  };
}
function normalize(
  input: PdsHostConfiguration,
): PdsHostConfiguration & { stagedIncomingMigration: boolean } {
  if (
    !input.hostId ||
    !input.serviceDid ||
    !Number.isSafeInteger(input.order) ||
    (input.stagedIncomingMigration !== undefined &&
      typeof input.stagedIncomingMigration !== "boolean")
  )
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
    stagedIncomingMigration: input.stagedIncomingMigration === true,
    order: input.order,
  };
}
export function createPdsRegistry(
  db: DatabaseExecutor,
  keyring?: PdsRegistryKeyring,
  publicTrust?: () => PdsRegistryPublicTrust,
): PdsRegistryStore & PdsCredentialRegistryStore {
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
  async function stageHost(
    input: PdsHostConfiguration,
    expectedRevision: number,
    idempotencyKey: string,
    onReplay?: (result: PdsHostRevision) => Promise<void>,
    onCreated?: (result: PdsHostRevision) => Promise<void>,
  ): Promise<PdsHostRevision> {
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
      if (prior) {
        await onReplay?.(prior);
        return prior;
      }
      const existingHost = (
        await db.read("pds_hosts", { where: eq(hosts.id, value.hostId) })
      )[0];
      if (existingHost?.association === "associated")
        throw new Error("PdsEnrollmentAliasConflict");
      await assertNoAssociatedPdsAlias(db, value);
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
        and(eq(hosts.id, value.hostId), eq(hosts.revision, expectedRevision))!,
      );
      if (!changed) {
        const retried = await replay();
        if (retried) {
          await onReplay?.(retried);
          return retried;
        }
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
        staged_incoming_migration: value.stagedIncomingMigration,
        configured_order: value.order,
      });
      await db.insert("pds_host_stage_requests", {
        host_id: value.hostId,
        idempotency_key: idempotencyKey,
        request,
        revision: next,
      });
      const result = { ...value, revision: next };
      await onCreated?.(result);
      return result;
    });
  }
  const credentials = db.tables.pds_host_credentials;
  const credentialRequests = db.tables.pds_host_credential_requests;
  function configuredKeyring(): PdsRegistryKeyring {
    if (!keyring) throw new Error("PdsRegistryKeyUnavailable");
    return keyring;
  }
  async function credentialRow(hostId: string, version: number) {
    const rows = await db.read("pds_host_credentials", {
      where: and(
        eq(credentials.host_id, hostId),
        eq(credentials.revision, version),
      ),
    });
    if (!rows[0]) throw new Error("PdsRegistryCredentialUnavailable");
    return rows[0];
  }
  async function readManifest(hostId: string, version: number) {
    const rows = await db.read("pds_host_manifests", {
      where: and(
        eq(db.tables.pds_host_manifests.host_id, hostId),
        eq(db.tables.pds_host_manifests.revision, version),
      ),
    });
    if (!rows[0]) return undefined;
    const revision = await readHostRevision(hostId, version);
    if (!revision) throw new Error("InvalidPdsRegistryManifest");
    try {
      const saved: unknown = JSON.parse(rows[0].manifest);
      if (
        !saved ||
        typeof saved !== "object" ||
        Array.isArray(saved) ||
        !("trust" in saved) ||
        !saved.trust ||
        typeof saved.trust !== "object" ||
        Array.isArray(saved.trust)
      )
        throw new Error();
      const trustRecord = saved.trust as Record<string, unknown>;
      if (
        Object.keys(trustRecord).length !== 4 ||
        !["issuer", "serviceDid", "jwtPublicKeyHex", "plcRotationKeyDid"].every(
          (key) => typeof trustRecord[key] === "string",
        )
      )
        throw new Error();
      const trust = {
        issuer: trustRecord.issuer as string,
        serviceDid: trustRecord.serviceDid as string,
        jwtPublicKeyHex: trustRecord.jwtPublicKeyHex as string,
        plcRotationKeyDid: trustRecord.plcRotationKeyDid as string,
      };
      const result = pdsRegistryManifest(revision, trust);
      if (
        rows[0].fingerprint !== result.fingerprint ||
        rows[0].manifest !== JSON.stringify(result.manifest)
      )
        throw new Error();
      return result;
    } catch {
      throw new Error("InvalidPdsRegistryManifest");
    }
  }
  return {
    stageHost,
    readManifest,
    async stageHostWithCredentials(input, expectedRevision, idempotencyKey) {
      const keys = configuredKeyring();
      const hostInput = normalize(input.host);
      const { outboundPassword, inboundToken } = input.credentials;
      if (
        typeof outboundPassword !== "string" ||
        !outboundPassword ||
        Buffer.from(outboundPassword, "utf8").toString("utf8") !==
          outboundPassword ||
        typeof inboundToken !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(inboundToken) ||
        Buffer.from(inboundToken, "base64url").length !== 32 ||
        Buffer.from(inboundToken, "base64url").toString("base64url") !==
          inboundToken
      )
        throw new Error("InvalidPdsRegistryCredential");
      const requestFor = (trust: PdsRegistryPublicTrust) => [
        1,
        hostInput.hostId,
        hostInput.serviceDid,
        hostInput.publicUrl,
        hostInput.internalUrl,
        hostInput.order,
        hostInput.stagedIncomingMigration === true,
        trust.issuer,
        trust.serviceDid,
        trust.jwtPublicKeyHex,
        trust.plcRotationKeyDid,
        expectedRevision,
        outboundPassword,
        inboundToken,
      ];
      return stageHost(
        hostInput,
        expectedRevision,
        idempotencyKey,
        async (result) => {
          const rows = await db.read("pds_host_credential_requests", {
            where: and(
              eq(credentialRequests.host_id, hostInput.hostId),
              eq(credentialRequests.idempotency_key, idempotencyKey),
            ),
          });
          const row = rows[0];
          const saved = await readManifest(result.hostId, result.revision);
          if (
            !row ||
            !saved ||
            row.revision !== result.revision ||
            !equalPdsDigest(
              Buffer.from(row.digest, "base64"),
              pdsStageDigest(
                keys,
                row.key_id,
                requestFor(saved.manifest.trust),
              ),
            )
          )
            throw new Error("PdsHostIdempotencyConflict");
        },
        async (result) => {
          if (!publicTrust) throw new Error("PdsTrustConfigurationUnavailable");
          const trust = publicTrust();
          // The enclosing authority transaction serializes writers across nodes.
          const existingCredentials = await db.read("pds_host_credentials");
          for (const existing of existingCredentials) {
            const existingInbound = Buffer.from(
              existing.inbound_digest,
              "base64",
            );
            const existingOutbound = decryptPdsCredential(
              keys,
              existing.host_id,
              "outbound-admin",
              existing.revision,
              {
                keyId: existing.key_id,
                nonce: existing.nonce,
                ciphertext: existing.ciphertext,
                tag: existing.tag,
              },
            );
            if (
              (existing.host_id !== result.hostId &&
                equalPdsDigest(
                  existingInbound,
                  pdsInboundDigest(existing.host_id, inboundToken),
                )) ||
              equalPdsDigest(
                existingInbound,
                pdsInboundDigest(existing.host_id, outboundPassword),
              ) ||
              equalPdsDigest(
                pdsInboundDigest(existing.host_id, existingOutbound),
                pdsInboundDigest(existing.host_id, inboundToken),
              )
            )
              throw new Error("PdsInboundCredentialConflict");
          }
          const encrypted = encryptPdsCredential(
            keys,
            result.hostId,
            "outbound-admin",
            result.revision,
            outboundPassword,
          );
          const { manifest, fingerprint } = pdsRegistryManifest(result, trust);
          await db.insert("pds_host_manifests", {
            host_id: result.hostId,
            revision: result.revision,
            manifest: JSON.stringify(manifest),
            fingerprint,
          });
          await db.insert("pds_host_credentials", {
            host_id: result.hostId,
            revision: result.revision,
            key_id: encrypted.keyId,
            nonce: encrypted.nonce,
            ciphertext: encrypted.ciphertext,
            tag: encrypted.tag,
            inbound_digest: pdsInboundDigest(
              result.hostId,
              inboundToken,
            ).toString("base64"),
          });
          await db.insert("pds_host_credential_requests", {
            host_id: result.hostId,
            idempotency_key: idempotencyKey,
            key_id: keys.activeKeyId,
            digest: pdsStageDigest(
              keys,
              keys.activeKeyId,
              requestFor(trust),
            ).toString("base64"),
            revision: result.revision,
          });
        },
      );
    },
    async readOutbound(hostId, version) {
      const row = await credentialRow(hostId, version);
      return decryptPdsCredential(
        configuredKeyring(),
        hostId,
        "outbound-admin",
        version,
        {
          keyId: row.key_id,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          tag: row.tag,
        },
      );
    },
    async verifyInbound(hostId, version, token) {
      const row = await credentialRow(hostId, version);
      return equalPdsDigest(
        Buffer.from(row.inbound_digest, "base64"),
        pdsInboundDigest(hostId, token),
      );
    },
    async rewrap(hostId, version, expectedKeyId) {
      const keys = configuredKeyring();
      return db.transact(async () => {
        const row = await credentialRow(hostId, version);
        if (row.key_id !== expectedKeyId) return "conflict";
        const plaintext = decryptPdsCredential(
          keys,
          hostId,
          "outbound-admin",
          version,
          {
            keyId: row.key_id,
            nonce: row.nonce,
            ciphertext: row.ciphertext,
            tag: row.tag,
          },
        );
        if (row.key_id === keys.activeKeyId) return "already-current";
        const next = encryptPdsCredential(
          keys,
          hostId,
          "outbound-admin",
          version,
          plaintext,
        );
        const changed = await db.update(
          "pds_host_credentials",
          {
            key_id: next.keyId,
            nonce: next.nonce,
            ciphertext: next.ciphertext,
            tag: next.tag,
          },
          and(
            eq(credentials.host_id, hostId),
            eq(credentials.revision, version),
            eq(credentials.key_id, row.key_id),
            eq(credentials.nonce, row.nonce),
            eq(credentials.ciphertext, row.ciphertext),
            eq(credentials.tag, row.tag),
          )!,
        );
        return changed ? "rewrapped" : "conflict";
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
