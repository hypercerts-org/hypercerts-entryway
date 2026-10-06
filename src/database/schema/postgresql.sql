CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" bigint,
	"refreshTokenExpiresAt" bigint,
	"scope" text,
	"password" text,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_bindings" (
	"did" text PRIMARY KEY,
	"user_id" text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"did" text PRIMARY KEY,
	"email" text NOT NULL,
	"handle" text NOT NULL,
	"pds_id" text NOT NULL,
	"status" text NOT NULL,
	"data" text NOT NULL,
	"sequence" bigint NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE "backup_emails" (
	"email" text PRIMARY KEY,
	"did" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_claims" (
	"email" text PRIMARY KEY,
	"did" text NOT NULL,
	"purpose" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handle_claims" (
	"handle" text PRIMARY KEY,
	"did" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "key_value_state" (
	"namespace" text,
	"key" text,
	"value" text NOT NULL,
	CONSTRAINT "key_value_state_pkey" PRIMARY KEY("namespace","key")
);
--> statement-breakpoint
CREATE TABLE "mail_outbox" (
	"id" text PRIMARY KEY,
	"recipient" text NOT NULL,
	"purpose" text NOT NULL,
	"code" text,
	"projection_field" text NOT NULL,
	"projection_token" text,
	"state" text NOT NULL,
	"last_error_code" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"attempt_count" bigint NOT NULL,
	"next_attempt_at" bigint NOT NULL,
	"delivered_at" bigint,
	CONSTRAINT "mail_projection_field" CHECK ("projection_field" IN ('otp','token')),
	CONSTRAINT "mail_attempts" CHECK ("attempt_count" BETWEEN 0 AND 3),
	CONSTRAINT "mail_state" CHECK ("state" IN ('queued','delivered','failed','expired')),
	CONSTRAINT "mail_expiry" CHECK ("expires_at">"created_at"),
	CONSTRAINT "mail_delivery" CHECK (("state"='delivered' AND "delivered_at" IS NOT NULL AND "code" IS NULL) OR ("state"!='delivered' AND "delivered_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "migration_checkpoint" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "migration_checkpoint_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"workflow_id" text NOT NULL,
	"phase" text NOT NULL,
	"command_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_custody_inventory" (
	"did" text PRIMARY KEY,
	"value" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_reservations" (
	"workflow_id" text PRIMARY KEY,
	"did" text NOT NULL UNIQUE,
	"handle" text NOT NULL,
	"email" text NOT NULL,
	"user_id" text NOT NULL UNIQUE,
	"session_id" text NOT NULL,
	"target_pds_id" text NOT NULL,
	"target_pds_url" text NOT NULL,
	"state" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "migration_reservation_state" CHECK ("state" IN ('reserved','placed','complete'))
);
--> statement-breakpoint
CREATE TABLE "migration_snapshot_manifest" (
	"workflow_id" text PRIMARY KEY,
	"manifest" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_workflow" (
	"id" text PRIMARY KEY,
	"did" text NOT NULL UNIQUE,
	"version" integer NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"expiresAt" bigint NOT NULL,
	"token" text NOT NULL UNIQUE,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" bigint NOT NULL,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "provider_account_user_id" ON "account" ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_email_ci" ON "accounts" (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_handle_ci" ON "accounts" (lower("handle"));--> statement-breakpoint
CREATE INDEX "accounts_pds_status" ON "accounts" ("pds_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "backup_emails_ci" ON "backup_emails" (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "email_claims_ci" ON "email_claims" (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "handle_claims_ci" ON "handle_claims" (lower("handle"));--> statement-breakpoint
CREATE INDEX "oauth_device_account_did_idx" ON "key_value_state" (("value"::jsonb ->> 'did'),"key") WHERE "namespace"='oauth:device-accounts';--> statement-breakpoint
CREATE INDEX "oauth_device_account_device_id_idx" ON "key_value_state" (("value"::jsonb ->> 'deviceId'),"key") WHERE "namespace"='oauth:device-accounts';--> statement-breakpoint
CREATE INDEX "mail_outbox_retry_idx" ON "mail_outbox" ("state","next_attempt_at","expires_at");--> statement-breakpoint
CREATE INDEX "mail_outbox_supersede_idx" ON "mail_outbox" ("recipient","purpose","state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_checkpoint_command" ON "migration_checkpoint" ("workflow_id","phase","command_id");--> statement-breakpoint
CREATE INDEX "migration_checkpoint_workflow_idx" ON "migration_checkpoint" ("workflow_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_email_ci" ON "migration_reservations" (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "migration_handle_ci" ON "migration_reservations" (lower("handle"));--> statement-breakpoint
CREATE INDEX "session_user_id" ON "session" ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_ci" ON "user" (lower("email"));--> statement-breakpoint
CREATE INDEX "verification_identifier" ON "verification" ("identifier");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "account_bindings" ADD CONSTRAINT "account_bindings_did_accounts_did_fkey" FOREIGN KEY ("did") REFERENCES "accounts"("did");--> statement-breakpoint
ALTER TABLE "account_bindings" ADD CONSTRAINT "account_bindings_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "backup_emails" ADD CONSTRAINT "backup_emails_did_accounts_did_fkey" FOREIGN KEY ("did") REFERENCES "accounts"("did");--> statement-breakpoint
ALTER TABLE "email_claims" ADD CONSTRAINT "email_claims_did_accounts_did_fkey" FOREIGN KEY ("did") REFERENCES "accounts"("did");--> statement-breakpoint
ALTER TABLE "handle_claims" ADD CONSTRAINT "handle_claims_did_accounts_did_fkey" FOREIGN KEY ("did") REFERENCES "accounts"("did");--> statement-breakpoint
ALTER TABLE "migration_checkpoint" ADD CONSTRAINT "migration_checkpoint_workflow_id_migration_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "migration_workflow"("id");--> statement-breakpoint
ALTER TABLE "migration_snapshot_manifest" ADD CONSTRAINT "migration_snapshot_manifest_MV6jDrceH3um_fkey" FOREIGN KEY ("workflow_id") REFERENCES "migration_workflow"("id");--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;