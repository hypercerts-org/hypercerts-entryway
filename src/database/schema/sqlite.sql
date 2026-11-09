CREATE TABLE `account` (
	`id` text PRIMARY KEY,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`password` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	CONSTRAINT `fk_account_userId_user_id_fk` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `account_bindings` (
	`did` text PRIMARY KEY,
	`user_id` text NOT NULL,
	CONSTRAINT `fk_account_bindings_did_accounts_did_fk` FOREIGN KEY (`did`) REFERENCES `accounts`(`did`),
	CONSTRAINT `fk_account_bindings_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`)
);
--> statement-breakpoint
CREATE TABLE `accounts` (
	`did` text PRIMARY KEY,
	`email` text NOT NULL,
	`handle` text NOT NULL,
	`pds_id` text NOT NULL,
	`status` text NOT NULL,
	`data` text NOT NULL,
	`sequence` integer NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE `arrival_attempts` (
	`attempt_binding` text PRIMARY KEY,
	`operation_id` text NOT NULL,
	`reason` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`fence` integer NOT NULL,
	CONSTRAINT `fk_arrival_attempts_operation_id_arrivals_operation_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `arrivals`(`operation_id`)
);
--> statement-breakpoint
CREATE TABLE `arrival_code` (
	`operation_id` text PRIMARY KEY,
	`code_hash` text NOT NULL,
	`generation` integer NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_arrival_code_operation_id_arrivals_operation_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `arrivals`(`operation_id`),
	CONSTRAINT "arrival_code_lifetime" CHECK("expires_at" > "issued_at"),
	CONSTRAINT "arrival_code_ceiling" CHECK("expires_at" <= "issued_at" + 86400000)
);
--> statement-breakpoint
CREATE TABLE `arrival_families` (
	`family_id` text PRIMARY KEY,
	`operation_id` text NOT NULL,
	`pds_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	CONSTRAINT `fk_arrival_families_operation_id_arrivals_operation_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `arrivals`(`operation_id`)
);
--> statement-breakpoint
CREATE TABLE `arrival_replay` (
	`operation_id` text NOT NULL,
	`method` text NOT NULL,
	`request_digest` text NOT NULL,
	`generation` integer NOT NULL,
	`accepted_at` integer NOT NULL,
	CONSTRAINT `arrival_replay_pk` PRIMARY KEY(`operation_id`, `method`, `request_digest`),
	CONSTRAINT "arrival_replay_digest" CHECK(length("request_digest") = 64)
);
--> statement-breakpoint
CREATE TABLE `arrival_reservations` (
	`operation_id` text PRIMARY KEY,
	`signing_key` text,
	`uncertain_reason` text,
	`uncertain_at` integer,
	`recorded_at` integer,
	CONSTRAINT `fk_arrival_reservations_operation_id_arrivals_operation_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `arrivals`(`operation_id`),
	CONSTRAINT "arrival_reservation_evidence" CHECK(("uncertain_reason" IS NULL AND "uncertain_at" IS NULL) OR ("uncertain_reason" IS NOT NULL AND "uncertain_at" IS NOT NULL)),
	CONSTRAINT "arrival_reservation_key" CHECK(("signing_key" IS NULL) OR "signing_key" LIKE 'did:key:z%')
);
--> statement-breakpoint
CREATE TABLE `arrival_signed_operations` (
	`operation_id` text NOT NULL,
	`kind` text NOT NULL,
	`did` text NOT NULL,
	`cid` text NOT NULL,
	`operation` text NOT NULL,
	`kind_operation_cid` text NOT NULL,
	`recorded_at` integer NOT NULL,
	CONSTRAINT `arrival_signed_operations_pk` PRIMARY KEY(`operation_id`, `kind`),
	CONSTRAINT `fk_arrival_signed_operations_operation_id_arrivals_operation_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `arrivals`(`operation_id`),
	CONSTRAINT "arrival_signed_kind" CHECK("kind" IN ('handoff','destination-move')),
	CONSTRAINT "arrival_signed_did" CHECK("did" LIKE 'did:%'),
	CONSTRAINT "arrival_signed_cid" CHECK("cid" LIKE 'baf%')
);
--> statement-breakpoint
CREATE TABLE `arrivals` (
	`operation_id` text PRIMARY KEY,
	`did` text NOT NULL,
	`did_root` text,
	`active` integer NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`handle` text NOT NULL,
	`pds_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`source_plc_head` text NOT NULL,
	`source_endpoint` text,
	`version` integer NOT NULL,
	`generation` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`cancelled_at` integer,
	`provisioned_at` integer,
	`deactivated_at` integer,
	`bound_at` integer,
	`activation_method` text,
	`activation_at` integer,
	`completed_at` integer,
	CONSTRAINT "arrival_active" CHECK("active" IN (0, 1)),
	CONSTRAINT "arrival_tuple" CHECK(("active" = 1 AND "did_root" = "did") OR ("active" = 0 AND "did_root" IS NULL)),
	CONSTRAINT "arrival_cancel" CHECK(("cancelled_at" IS NULL) OR ("cancelled_at" IS NOT NULL AND "active" = 0)),
	CONSTRAINT "arrival_bound" CHECK(("bound_at" IS NULL) OR ("bound_at" IS NOT NULL AND "deactivated_at" IS NOT NULL)),
	CONSTRAINT "arrival_complete" CHECK(("completed_at" IS NULL) OR ("completed_at" IS NOT NULL AND "bound_at" IS NOT NULL AND "activation_method" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `authority_operations` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`request_digest` text NOT NULL,
	`state` text NOT NULL,
	`worker_id` text,
	`attempt_id` text,
	`fence` integer NOT NULL,
	`attempt_count` integer NOT NULL,
	`lease_expires_at` integer,
	`pending` integer NOT NULL,
	`phase` text NOT NULL,
	`expected_state` text,
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backup_emails` (
	`email` text PRIMARY KEY,
	`did` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_backup_emails_did_accounts_did_fk` FOREIGN KEY (`did`) REFERENCES `accounts`(`did`)
);
--> statement-breakpoint
CREATE TABLE `custody_history` (
	`id` text PRIMARY KEY,
	`did` text NOT NULL,
	`cid` text NOT NULL,
	`kind` text NOT NULL,
	`supporting_observation_id` text,
	`operation_id` text,
	`provenance` text NOT NULL,
	`at` text NOT NULL,
	CONSTRAINT `fk_custody_history_supporting_observation_id_custody_observations_id_fk` FOREIGN KEY (`supporting_observation_id`) REFERENCES `custody_observations`(`id`)
);
--> statement-breakpoint
CREATE TABLE `custody_observations` (
	`id` text PRIMARY KEY,
	`did` text NOT NULL,
	`directory` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `custody_operations` (
	`did` text NOT NULL,
	`cid` text NOT NULL,
	`operation` text NOT NULL,
	CONSTRAINT `custody_operations_pk` PRIMARY KEY(`did`, `cid`)
);
--> statement-breakpoint
CREATE TABLE `email_claims` (
	`email` text NOT NULL,
	`did` text NOT NULL,
	`purpose` text NOT NULL,
	CONSTRAINT `email_claims_pk` PRIMARY KEY(`email`, `did`),
	CONSTRAINT `fk_email_claims_did_accounts_did_fk` FOREIGN KEY (`did`) REFERENCES `accounts`(`did`)
);
--> statement-breakpoint
CREATE TABLE `external_operation_attempts` (
	`id` text PRIMARY KEY,
	`operation_id` text NOT NULL,
	`step` text NOT NULL,
	`execution_attempt_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`fence` integer NOT NULL,
	`target` text NOT NULL,
	`method` text NOT NULL,
	`intent_digest` text NOT NULL,
	`state` text NOT NULL,
	`result` text,
	`recovery` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_external_operation_attempts_operation_id_authority_operations_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `authority_operations`(`id`)
);
--> statement-breakpoint
CREATE TABLE `handle_claims` (
	`handle` text PRIMARY KEY,
	`did` text NOT NULL,
	CONSTRAINT `fk_handle_claims_did_accounts_did_fk` FOREIGN KEY (`did`) REFERENCES `accounts`(`did`)
);
--> statement-breakpoint
CREATE TABLE `key_value_state` (
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `key_value_state_pk` PRIMARY KEY(`namespace`, `key`)
);
--> statement-breakpoint
CREATE TABLE `mail_outbox` (
	`id` text PRIMARY KEY,
	`recipient` text NOT NULL,
	`purpose` text NOT NULL,
	`code` text,
	`projection_field` text NOT NULL,
	`projection_token` text,
	`state` text NOT NULL,
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`attempt_count` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`delivered_at` integer,
	`claim_owner` text,
	`claim_attempt` text,
	`claim_version` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` integer,
	`delivery_uncertain` integer DEFAULT false NOT NULL,
	CONSTRAINT "mail_projection_field" CHECK("projection_field" IN ('otp','token')),
	CONSTRAINT "mail_attempts" CHECK("attempt_count" BETWEEN 0 AND 3),
	CONSTRAINT "mail_state" CHECK("state" IN ('queued','sending','delivered','failed','expired')),
	CONSTRAINT "mail_claim" CHECK(("state"='sending' AND "claim_owner" IS NOT NULL AND "claim_attempt" IS NOT NULL AND "lease_expires_at" IS NOT NULL) OR ("state"!='sending' AND "claim_owner" IS NULL AND "claim_attempt" IS NULL AND "lease_expires_at" IS NULL)),
	CONSTRAINT "mail_expiry" CHECK("expires_at">"created_at"),
	CONSTRAINT "mail_delivery" CHECK(("state"='delivered' AND "delivered_at" IS NOT NULL AND "code" IS NULL) OR ("state"!='delivered' AND "delivered_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `migration_checkpoint` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`workflow_id` text NOT NULL,
	`phase` text NOT NULL,
	`command_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_migration_checkpoint_workflow_id_migration_workflow_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `migration_workflow`(`id`)
);
--> statement-breakpoint
CREATE TABLE `migration_custody_inventory` (
	`did` text PRIMARY KEY,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `migration_reservations` (
	`workflow_id` text PRIMARY KEY,
	`did` text NOT NULL UNIQUE,
	`handle` text NOT NULL,
	`email` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`target_pds_id` text NOT NULL,
	`target_pds_url` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "migration_reservation_state" CHECK("state" IN ('reserved','placed','complete'))
);
--> statement-breakpoint
CREATE TABLE `migration_snapshot_manifest` (
	`workflow_id` text PRIMARY KEY,
	`manifest` text NOT NULL,
	CONSTRAINT `fk_migration_snapshot_manifest_workflow_id_migration_workflow_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `migration_workflow`(`id`)
);
--> statement-breakpoint
CREATE TABLE `migration_workflow` (
	`id` text PRIMARY KEY,
	`did` text NOT NULL UNIQUE,
	`version` integer NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operation_admissions` (
	`resource` text PRIMARY KEY,
	`operation_id` text NOT NULL,
	CONSTRAINT `fk_operation_admissions_operation_id_authority_operations_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `authority_operations`(`id`)
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY,
	`expiresAt` integer NOT NULL,
	`token` text NOT NULL UNIQUE,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL,
	CONSTRAINT `fk_session_userId_user_id_fk` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`emailVerified` integer DEFAULT false NOT NULL,
	`image` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `provider_account_user_id` ON `account` (`userId`);--> statement-breakpoint
CREATE INDEX `account_bindings_user_id` ON `account_bindings` (`user_id`);--> statement-breakpoint
CREATE INDEX `accounts_email_ci` ON `accounts` (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_handle_ci` ON `accounts` (lower("handle"));--> statement-breakpoint
CREATE INDEX `accounts_pds_status` ON `accounts` (`pds_id`,`status`);--> statement-breakpoint
CREATE INDEX `arrival_attempt_operation` ON `arrival_attempts` (`operation_id`);--> statement-breakpoint
CREATE INDEX `arrival_family_operation` ON `arrival_families` (`operation_id`,`revoked_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `arrival_signed_kind_cid` ON `arrival_signed_operations` (`operation_id`,`kind_operation_cid`);--> statement-breakpoint
CREATE UNIQUE INDEX `arrivals_did_active` ON `arrivals` (`did_root`);--> statement-breakpoint
CREATE INDEX `arrivals_did` ON `arrivals` (`did`,`created_at`);--> statement-breakpoint
CREATE INDEX `arrivals_user` ON `arrivals` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `arrivals_email` ON `arrivals` (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX `arrivals_handle_active` ON `arrivals` (lower("handle")) WHERE "arrivals"."did_root" IS NOT NULL AND "arrivals"."cancelled_at" IS NULL AND "arrivals"."provisioned_at" IS NULL;--> statement-breakpoint
CREATE INDEX `arrivals_handle` ON `arrivals` (lower("handle"),`created_at`);--> statement-breakpoint
CREATE INDEX `authority_operation_lease` ON `authority_operations` (`state`,`lease_expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `backup_emails_ci` ON `backup_emails` (lower("email"));--> statement-breakpoint
CREATE INDEX `custody_history_did` ON `custody_history` (`did`);--> statement-breakpoint
CREATE UNIQUE INDEX `email_claims_exclusive_ci` ON `email_claims` (lower("email")) WHERE "email_claims"."purpose" IN ('backup','pending');--> statement-breakpoint
CREATE INDEX `external_operation_step` ON `external_operation_attempts` (`operation_id`,`step`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `handle_claims_ci` ON `handle_claims` (lower("handle"));--> statement-breakpoint
CREATE INDEX `oauth_device_account_did_idx` ON `key_value_state` (json_extract("value",'$.did'),`key`) WHERE "key_value_state"."namespace"='oauth:device-accounts';--> statement-breakpoint
CREATE INDEX `oauth_device_account_device_id_idx` ON `key_value_state` (json_extract("value",'$.deviceId'),`key`) WHERE "key_value_state"."namespace"='oauth:device-accounts';--> statement-breakpoint
CREATE INDEX `mail_outbox_retry_idx` ON `mail_outbox` (`state`,`next_attempt_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `mail_outbox_supersede_idx` ON `mail_outbox` (`recipient`,`purpose`,`state`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `migration_checkpoint_command` ON `migration_checkpoint` (`workflow_id`,`phase`,`command_id`);--> statement-breakpoint
CREATE INDEX `migration_checkpoint_workflow_idx` ON `migration_checkpoint` (`workflow_id`,`id`);--> statement-breakpoint
CREATE INDEX `migration_email_ci` ON `migration_reservations` (lower("email"));--> statement-breakpoint
CREATE INDEX `migration_user_id` ON `migration_reservations` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `migration_handle_ci` ON `migration_reservations` (lower("handle"));--> statement-breakpoint
CREATE INDEX `operation_admission_id` ON `operation_admissions` (`operation_id`);--> statement-breakpoint
CREATE INDEX `session_user_id` ON `session` (`userId`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_ci` ON `user` (lower("email"));--> statement-breakpoint
CREATE INDEX `verification_identifier` ON `verification` (`identifier`);