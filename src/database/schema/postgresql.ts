import {
  pgTable as table,
  text,
  integer,
  bigint,
  boolean,
  customType,
  primaryKey,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
const time = customType<{ data: Date; driverData: string }>({
  dataType: () => "bigint",
  toDriver: (value) => String(value.getTime()),
  fromDriver: (value) => new Date(Number(value)),
});
const count = (name: string) => bigint(name, { mode: "number" });
// Explicit Better Auth 1.7.3 core schema; emailOTP persists proofs in verification.
export const user = table(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("emailVerified").notNull().default(false),
    image: text("image"),
    createdAt: time("createdAt").notNull(),
    updatedAt: time("updatedAt").notNull(),
  },
  (t) => [uniqueIndex("user_email_ci").on(sql`lower(${t.email})`)],
);
export const session = table(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: time("expiresAt").notNull(),
    token: text("token").notNull().unique(),
    createdAt: time("createdAt").notNull(),
    updatedAt: time("updatedAt").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id").on(t.userId)],
);
export const account = table(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: time("accessTokenExpiresAt"),
    refreshTokenExpiresAt: time("refreshTokenExpiresAt"),
    scope: text("scope"),
    password: text("password"),
    createdAt: time("createdAt").notNull(),
    updatedAt: time("updatedAt").notNull(),
  },
  (t) => [index("provider_account_user_id").on(t.userId)],
);
export const verification = table(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: time("expiresAt").notNull(),
    createdAt: time("createdAt").notNull(),
    updatedAt: time("updatedAt").notNull(),
  },
  (t) => [index("verification_identifier").on(t.identifier)],
);
export const accounts = table(
  "accounts",
  {
    did: text("did").notNull().primaryKey(),
    email: text("email").notNull(),
    handle: text("handle").notNull(),
    pds_id: text("pds_id").notNull(),
    status: text("status").notNull(),
    data: text("data").notNull(),
    sequence: count("sequence").notNull().unique(),
  },
  (t) => [
    uniqueIndex("accounts_email_ci").on(sql`lower(${t.email})`),
    uniqueIndex("accounts_handle_ci").on(sql`lower(${t.handle})`),
    index("accounts_pds_status").on(t.pds_id, t.status),
  ],
);
export const handle_claims = table(
  "handle_claims",
  {
    handle: text("handle").primaryKey(),
    did: text("did")
      .notNull()
      .references(() => accounts.did),
  },
  (t) => [uniqueIndex("handle_claims_ci").on(sql`lower(${t.handle})`)],
);
export const email_claims = table(
  "email_claims",
  {
    email: text("email").primaryKey(),
    did: text("did")
      .notNull()
      .references(() => accounts.did),
    purpose: text("purpose").notNull(),
  },
  (t) => [uniqueIndex("email_claims_ci").on(sql`lower(${t.email})`)],
);
export const account_bindings = table(
  "account_bindings",
  {
    did: text("did")
      .primaryKey()
      .references(() => accounts.did),
    user_id: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id),
  },
  (t) => [],
);
export const backup_emails = table(
  "backup_emails",
  {
    email: text("email").primaryKey(),
    did: text("did")
      .notNull()
      .references(() => accounts.did),
    created_at: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("backup_emails_ci").on(sql`lower(${t.email})`)],
);
export const migration_reservations = table(
  "migration_reservations",
  {
    workflow_id: text("workflow_id").notNull().primaryKey(),
    did: text("did").notNull().unique(),
    handle: text("handle").notNull(),
    email: text("email").notNull(),
    user_id: text("user_id").notNull().unique(),
    session_id: text("session_id").notNull(),
    target_pds_id: text("target_pds_id").notNull(),
    target_pds_url: text("target_pds_url").notNull(),
    state: text("state").notNull(),
    created_at: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("migration_email_ci").on(sql`lower(${t.email})`),
    uniqueIndex("migration_handle_ci").on(sql`lower(${t.handle})`),
    check(
      "migration_reservation_state",
      sql`${t.state} IN ('reserved','placed','complete')`,
    ),
  ],
);
export const key_value_state = table(
  "key_value_state",
  {
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.namespace, t.key] }),
    index("oauth_device_account_did_idx")
      .on(sql`(${t.value}::jsonb ->> 'did')`, t.key)
      .where(sql`${t.namespace}='oauth:device-accounts'`),
    index("oauth_device_account_device_id_idx")
      .on(sql`(${t.value}::jsonb ->> 'deviceId')`, t.key)
      .where(sql`${t.namespace}='oauth:device-accounts'`),
  ],
);
export const migration_workflow = table(
  "migration_workflow",
  {
    id: text("id").primaryKey(),
    did: text("did").notNull().unique(),
    version: integer("version").notNull(),
    value: text("value").notNull(),
  },
  (t) => [],
);
export const migration_checkpoint = table(
  "migration_checkpoint",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    workflow_id: text("workflow_id")
      .notNull()
      .references(() => migration_workflow.id),
    phase: text("phase").notNull(),
    command_id: text("command_id").notNull(),
    created_at: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("migration_checkpoint_command").on(
      t.workflow_id,
      t.phase,
      t.command_id,
    ),
    index("migration_checkpoint_workflow_idx").on(t.workflow_id, t.id),
  ],
);
export const migration_snapshot_manifest = table(
  "migration_snapshot_manifest",
  {
    workflow_id: text("workflow_id")
      .primaryKey()
      .references(() => migration_workflow.id),
    manifest: text("manifest").notNull(),
  },
  (t) => [],
);
export const migration_custody_inventory = table(
  "migration_custody_inventory",
  {
    did: text("did").primaryKey(),
    value: text("value").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [],
);
export const authority_operations = table(
  "authority_operations",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    request_digest: text("request_digest").notNull(),
    state: text("state").notNull(),
    worker_id: text("worker_id"),
    attempt_id: text("attempt_id"),
    fence: count("fence").notNull(),
    attempt_count: count("attempt_count").notNull(),
    lease_expires_at: count("lease_expires_at"),
    pending: boolean("pending").notNull(),
    phase: text("phase").notNull(),
    expected_state: text("expected_state"),
    last_error_code: text("last_error_code"),
    created_at: count("created_at").notNull(),
    updated_at: count("updated_at").notNull(),
  },
  (t) => [index("authority_operation_lease").on(t.state, t.lease_expires_at)],
);
export const operation_admissions = table(
  "operation_admissions",
  {
    resource: text("resource").primaryKey(),
    operation_id: text("operation_id")
      .notNull()
      .references(() => authority_operations.id),
  },
  (t) => [index("operation_admission_id").on(t.operation_id)],
);
export const external_operation_attempts = table(
  "external_operation_attempts",
  {
    id: text("id").primaryKey(),
    operation_id: text("operation_id")
      .notNull()
      .references(() => authority_operations.id),
    step: text("step").notNull(),
    execution_attempt_id: text("execution_attempt_id").notNull(),
    worker_id: text("worker_id").notNull(),
    fence: count("fence").notNull(),
    target: text("target").notNull(),
    method: text("method").notNull(),
    intent_digest: text("intent_digest").notNull(),
    state: text("state").notNull(),
    result: text("result"),
    recovery: text("recovery"),
    created_at: count("created_at").notNull(),
    updated_at: count("updated_at").notNull(),
  },
  (t) => [
    index("external_operation_step").on(t.operation_id, t.step, t.created_at),
  ],
);
export const mail_outbox = table(
  "mail_outbox",
  {
    id: text("id").primaryKey(),
    recipient: text("recipient").notNull(),
    purpose: text("purpose").notNull(),
    code: text("code"),
    projection_field: text("projection_field").notNull(),
    projection_token: text("projection_token"),
    state: text("state").notNull(),
    last_error_code: text("last_error_code"),
    created_at: count("created_at").notNull(),
    expires_at: count("expires_at").notNull(),
    attempt_count: count("attempt_count").notNull(),
    next_attempt_at: count("next_attempt_at").notNull(),
    delivered_at: count("delivered_at"),
    claim_owner: text("claim_owner"),
    claim_attempt: text("claim_attempt"),
    claim_version: count("claim_version").notNull().default(0),
    lease_expires_at: count("lease_expires_at"),
    delivery_uncertain: boolean("delivery_uncertain").notNull().default(false),
  },
  (t) => [
    index("mail_outbox_retry_idx").on(t.state, t.next_attempt_at, t.expires_at),
    index("mail_outbox_supersede_idx").on(
      t.recipient,
      t.purpose,
      t.state,
      t.created_at,
    ),
    check(
      "mail_projection_field",
      sql`${t.projection_field} IN ('otp','token')`,
    ),
    check("mail_attempts", sql`${t.attempt_count} BETWEEN 0 AND 3`),
    check(
      "mail_state",
      sql`${t.state} IN ('queued','sending','delivered','failed','expired')`,
    ),
    check(
      "mail_claim",
      sql`(${t.state}='sending' AND ${t.claim_owner} IS NOT NULL AND ${t.claim_attempt} IS NOT NULL AND ${t.lease_expires_at} IS NOT NULL) OR (${t.state}!='sending' AND ${t.claim_owner} IS NULL AND ${t.claim_attempt} IS NULL AND ${t.lease_expires_at} IS NULL)`,
    ),
    check("mail_expiry", sql`${t.expires_at}>${t.created_at}`),
    check(
      "mail_delivery",
      sql`(${t.state}='delivered' AND ${t.delivered_at} IS NOT NULL AND ${t.code} IS NULL) OR (${t.state}!='delivered' AND ${t.delivered_at} IS NULL)`,
    ),
  ],
);
