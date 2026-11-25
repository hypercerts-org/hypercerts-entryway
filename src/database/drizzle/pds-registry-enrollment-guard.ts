import { ne, or } from "drizzle-orm";
import { isValidDid } from "@atproto/syntax";
import type { DatabaseExecutor, TableName } from "../executor.js";
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
  for (const table of productTables)
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
  await assertNoPdsAuthorityReferences(db);
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
  const associated = new Set(
    (await db.read("pds_hosts"))
      .filter((host) => host.association === "associated")
      .map((host) => host.id),
  );
  if (!associated.size) return;
  const did = canonicalDid(candidate.serviceDid);
  const endpoints = new Set([
    canonicalEndpoint(candidate.publicUrl),
    canonicalEndpoint(candidate.internalUrl),
  ]);
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
