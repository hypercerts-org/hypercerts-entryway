import { and, eq, ne, or } from "drizzle-orm";
import { isValidDid } from "@atproto/syntax";
import type { DatabaseExecutor, TableName } from "../executor.js";
import { assertCompletedSignupReferences } from "./pds-signup-reference-proof.js";
import type {
  PdsHostConfiguration,
  PdsHostRevision,
} from "../pds-registry.port.js";

// This first-enrollment guard deliberately requires an empty product authority.
// It does not attempt to interpret or migrate historical workflow journals.
const productTables: TableName[] = [
  "user",
  "session",
  "account",
  "verification",
  "accounts",
  "handle_claims",
  "email_claims",
  "account_bindings",
  "backup_emails",
  "migration_reservations",
  "arrivals",
  "arrival_code",
  "arrival_reservations",
  "arrival_signed_operations",
  "arrival_replay",
  "arrival_attempts",
  "arrival_families",
  "key_value_state",
  "migration_workflow",
  "migration_checkpoint",
  "migration_snapshot_manifest",
  "migration_custody_inventory",
  "custody_operations",
  "custody_observations",
  "custody_history",
  "pds_placement_reservations",
  "authority_operations",
  "operation_admissions",
  "external_operation_attempts",
];

function canonicalDid(did: string): string {
  if (!isValidDid(did)) throw new Error("PdsEnrollmentIdentityInvalid");
  if (did.startsWith("did:plc:")) {
    const value = did.slice(8);
    if (!/^[a-z2-7]{24}$/.test(value))
      throw new Error("PdsEnrollmentIdentityInvalid");
    return did;
  }
  if (!did.startsWith("did:web:"))
    throw new Error("PdsEnrollmentIdentityInvalid");
  try {
    const [authority, ...path] = did.slice(8).split(":");
    if (!authority || path.some((part) => !part)) throw Error();
    const decodedAuthority = decodeURIComponent(authority);
    const url = new URL(`https://${decodedAuthority}/`);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw Error();
    const decodedPath = path.map((part) => decodeURIComponent(part));
    if (
      decodedPath.some(
        (part) => part.includes("/") || part === "." || part === "..",
      )
    )
      throw Error();
    return JSON.stringify(["did:web", url.host, ...decodedPath]);
  } catch {
    throw new Error("PdsEnrollmentIdentityInvalid");
  }
}
function canonicalEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname.includes("%") ||
      url.search ||
      url.hash
    )
      throw Error();
    return url.href;
  } catch {
    throw new Error("PdsEnrollmentIdentityInvalid");
  }
}

/** Conservative reference proof for fresh-only lifecycle operations. */
export async function assertNoPdsAuthorityReferences(
  db: DatabaseExecutor,
  ignoreReleasedPlacements = false,
): Promise<void> {
  for (const table of productTables) {
    if (table === "authority_operations" && ignoreReleasedPlacements) {
      for (const operation of await db.read("authority_operations")) {
        if (
          operation.kind !== "unbound-key" ||
          operation.state !== "complete" ||
          operation.pending ||
          operation.phase !== "unbound-key-unused"
        )
          throw new Error("PdsEnrollmentReferencesExist");
        const attempts = await db.read("external_operation_attempts", {
          where: eq(
            db.tables.external_operation_attempts.operation_id,
            operation.id,
          ),
          limit: 1,
        });
        const placements = await db.read("pds_placement_reservations", {
          where: eq(
            db.tables.pds_placement_reservations.operation_id,
            operation.id,
          ),
        });
        if (
          attempts.length ||
          placements.some(
            (placement) =>
              placement.purpose !== "unbound-key" ||
              placement.state !== "released",
          )
        )
          throw new Error("PdsEnrollmentReferencesExist");
      }
      continue;
    }
    if (
      (
        await db.read(
          table,
          table === "pds_placement_reservations" && ignoreReleasedPlacements
            ? {
                where: ne(
                  db.tables.pds_placement_reservations.state,
                  "released",
                ),
                limit: 1,
              }
            : { limit: 1 },
        )
      ).length
    )
      throw new Error("PdsEnrollmentReferencesExist");
  }
  if (
    (
      await db.read("mail_outbox", {
        where: or(
          ne(db.tables.mail_outbox.purpose, "pds-health"),
          ne(db.tables.mail_outbox.message_kind, "admin"),
        ),
        limit: 1,
      })
    ).length
  )
    throw new Error("PdsEnrollmentReferencesExist");
}

/** Must be called within the transaction that records attestation or association. */
export async function assertFreshPdsEnrollment(
  db: DatabaseExecutor,
  candidate: PdsHostRevision,
): Promise<void> {
  const modes = await db.read("authority_mode");
  if (
    modes.length !== 1 ||
    modes[0]?.id !== 1 ||
    modes[0].mode !== "registry-bootstrap"
  )
    throw new Error("PdsEnrollmentModeConflict");
  const phases = await db.read("authority_phase");
  if (phases.length !== 1 || phases[0]?.id !== 1)
    throw new Error("PdsEnrollmentModeConflict");
  if (phases[0].phase === "bootstrap" && phases[0].generation === 1)
    await assertNoPdsAuthorityReferences(db);
  else if (phases[0].phase === "registry-serving" && phases[0].generation === 2)
    await assertNoPdsHostReferences(db, candidate.hostId);
  else throw new Error("PdsEnrollmentModeConflict");
  const did = canonicalDid(candidate.serviceDid);
  const endpoints = new Set([
    canonicalEndpoint(candidate.publicUrl),
    canonicalEndpoint(candidate.internalUrl),
  ]);
  for (const revision of await db.read("pds_host_revisions")) {
    if (revision.host_id === candidate.hostId) continue;
    if (
      canonicalDid(revision.service_did) === did ||
      endpoints.has(canonicalEndpoint(revision.public_url)) ||
      endpoints.has(canonicalEndpoint(revision.internal_url))
    )
      throw new Error("PdsEnrollmentAliasConflict");
  }
}

/** Serialize staging with association: associated historical aliases remain reserved. */
export async function assertNoAssociatedPdsAlias(
  db: DatabaseExecutor,
  candidate: PdsHostConfiguration,
): Promise<void> {
  const did = canonicalDid(candidate.serviceDid);
  const endpoints = new Set([
    canonicalEndpoint(candidate.publicUrl),
    canonicalEndpoint(candidate.internalUrl),
  ]);
  const associated = new Set(
    (await db.read("pds_hosts"))
      .filter((host) => host.association === "associated")
      .map((host) => host.id),
  );
  if (!associated.size) return;
  for (const revision of await db.read("pds_host_revisions")) {
    if (!associated.has(revision.host_id)) continue;
    if (
      canonicalDid(revision.service_did) === did ||
      endpoints.has(canonicalEndpoint(revision.public_url)) ||
      endpoints.has(canonicalEndpoint(revision.internal_url))
    )
      throw new Error("PdsEnrollmentAliasConflict");
  }
}

/**
 * Conservative host proof. A record whose host authority is not yet decoded
 * blocks the operation; callers must hold the physical authority transaction.
 */
export async function assertNoPdsHostReferences(
  db: DatabaseExecutor,
  hostId: string,
): Promise<void> {
  const revisions = (await db.read("pds_host_revisions")).filter(
    (revision) => revision.host_id === hostId,
  );
  if (!revisions.length) throw new Error("PdsEnrollmentIdentityInvalid");
  const identities = new Set(
    revisions.map((revision) => canonicalDid(revision.service_did)),
  );
  const endpoints = new Set(
    revisions.flatMap((revision) => [
      canonicalEndpoint(revision.public_url),
      canonicalEndpoint(revision.internal_url),
    ]),
  );
  for (const account of await db.read("accounts")) {
    let data: unknown;
    try {
      data = JSON.parse(account.data);
    } catch {
      throw new Error("PdsEnrollmentReferencesUnmapped");
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("PdsEnrollmentReferencesUnmapped");
    const record = data as Record<string, unknown>;
    if (
      record.pdsId !== account.pds_id ||
      typeof record.pdsUrl !== "string" ||
      typeof record.pdsRevision !== "number" ||
      !Number.isSafeInteger(record.pdsRevision) ||
      record.pdsRevision < 1
    )
      throw new Error("PdsEnrollmentReferencesUnmapped");
    const url = canonicalEndpoint(record.pdsUrl);
    if (
      account.pds_id === hostId ||
      endpoints.has(url) ||
      identities.has(canonicalDid(account.did))
    )
      throw new Error("PdsEnrollmentReferencesExist");
    const [revision] = await db.read("pds_host_revisions", {
      where: and(
        eq(db.tables.pds_host_revisions.host_id, account.pds_id),
        eq(db.tables.pds_host_revisions.revision, record.pdsRevision),
      ),
    });
    const [host] = await db.read("pds_hosts", {
      where: eq(db.tables.pds_hosts.id, account.pds_id),
    });
    const [association] = await db.read("pds_host_enrollment_events", {
      where: and(
        eq(db.tables.pds_host_enrollment_events.host_id, account.pds_id),
        eq(db.tables.pds_host_enrollment_events.revision, record.pdsRevision),
        eq(db.tables.pds_host_enrollment_events.kind, "associate"),
      ),
    });
    if (
      !revision ||
      !host ||
      host.association !== "associated" ||
      !association ||
      canonicalEndpoint(revision.public_url) !== url
    )
      throw new Error("PdsEnrollmentReferencesUnmapped");
    if (
      identities.has(canonicalDid(revision.service_did)) ||
      endpoints.has(canonicalEndpoint(revision.public_url)) ||
      endpoints.has(canonicalEndpoint(revision.internal_url))
    )
      throw new Error("PdsEnrollmentReferencesExist");
  }
  await assertCompletedSignupReferences(
    db,
    hostId,
    identities,
    endpoints,
    canonicalDid,
    canonicalEndpoint,
  );
  // These tables contain identity and authentication state only; the account
  // rows above own their DID-to-host mapping. Every other product table remains
  // fail-closed until its retained host references have an explicit decoder.
  const accountOnly = new Set<TableName>([
    "user",
    "session",
    "account",
    "verification",
    "accounts",
    "handle_claims",
    "email_claims",
    "account_bindings",
    "backup_emails",
    "key_value_state",
    "pds_placement_reservations",
    "authority_operations",
    "operation_admissions",
    "external_operation_attempts",
    "custody_operations",
    "custody_history",
    "custody_observations",
    "migration_custody_inventory",
  ]);
  for (const table of productTables) {
    if (!accountOnly.has(table) && (await db.read(table, { limit: 1 })).length)
      throw new Error("PdsEnrollmentReferencesUnmapped");
  }
  // Sign-in OTP mail belongs to the browser identity, independently of any
  // PDS. Unknown mail purposes remain a conservative reference blocker.
  for (const message of await db.read("mail_outbox")) {
    if (
      (message.purpose === "pds-health" && message.message_kind === "admin") ||
      (message.purpose === "sign-in" && message.message_kind === "otp")
    )
      continue;
    throw new Error("PdsEnrollmentReferencesUnmapped");
  }
}
