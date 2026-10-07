# Database configuration and contracts

Entryway uses Drizzle ORM and Drizzle Kit `1.0.0-rc.4`, `pg` `8.16.3`, and
Better Auth `1.7.3`. Existing account password and app-password APIs remain active.

| Setting            | Values and behavior                                            |
| ------------------ | -------------------------------------------------------------- |
| `DATABASE_BACKEND` | `sqlite` (default), or `postgresql`                            |
| `DEPLOYMENT_MODE`  | `single-node` (default), or `multi-node`                       |
| `DATABASE_URL`     | Required PostgreSQL URL for `postgresql`; forbidden for SQLite |
| `STATE_DIRECTORY`  | SQLite authority location; defaults to `/data`                 |

Single-node mode accepts either backend. Multi-node mode requires PostgreSQL;
SQLite plus multi-node fails with `InvalidDatabaseConfiguration` before startup.
Configuration errors exclude the supplied URL. Accepting the PostgreSQL multi-node
configuration is not evidence of replica failover or of operation lease behavior.
Those contracts have separate acceptance gates. [Shared operation ownership](shared-operations.md)
documents durable admissions, attempt fences, integrated account/PDS workflows,
operator-verified recovery, mail attempts and authentication ordering.
[Deployment lifecycle and profiles](deployment-profiles.md) define bounded
database probing, request/worker drain and replica checks. Fleet placement is
separate work.

Schemas are fresh, explicit dialect assets in `src/database/schema/`. Startup
serializes initialization, stores the schema asset hash in `schema_identity`, and
rejects a mismatched identity. Better Auth never runs separate schema mutations.
There is no old database upgrade chain. Public account migration and conversion
of an existing ePDS deployment are separate product requirements and are not
replaced by this initialization path.

Database readers and mutations return Promises. Features use the focused account,
authentication-state, OAuth, and mail contracts. Schema-backed Drizzle CRUD and
native drivers stay inside `src/database/`; explicit SQL is limited to schema
initialization, transaction control/locking, and dialect expressions. Better Auth's
public Drizzle adapter uses the same physical transaction context as account
identity, claims, browser sessions, and revocation mutations.

SQLite has one application connection and a gate covering every reader, mutation,
and provider adapter call. An async authority transaction holds that gate through
commit or rollback; nested operations reuse its connection with savepoints.
Concurrent startup in one process is gated before opening the file. No async
callback is passed to better-sqlite3's synchronous transaction API. PostgreSQL
pins one client per transaction and takes an advisory transaction lock for
multi-statement authority mutations. This deliberately serializes writes for the
foundation; independent connections still read committed state. Closing rejects
new work and drains admitted transactions before closing the driver or pool.

OAuth rotation retains revocation-only links
from historical token IDs to their successors, so delayed revocation invalidates
the current family while historical IDs remain unavailable to access-token reads.
Challenge issuance revalidates its captured account/email inside the transaction
that records its security version; SMTP remains outside that transaction.

Fresh exports are reproducible. Inside an owned AiaB tooling/test container, run
`npm run schema:export` to regenerate the two checked-in SQL assets, or
`npm run schema:check` to compare fresh exports without changing them. The exporter
uses a new ignored scratch directory on every invocation. Build copies both SQL
assets into `dist/src/database/schema/`. Runtime evidence hashes source and copied
SQL, package pins, schema configurations, and the export/copy scripts.

After the normal managed `prepare` and `up`, `./tests/local.sh database-contracts`
runs the same schema/authority/provider/mail contracts against fresh SQLite and
PostgreSQL fixtures, then creates a separate fresh AiaB project for the one-node
PostgreSQL application profile. Contract receipts name the backend, exact command,
actual exit, test files, and source manifest; JUnit contains individual case
results. PostgreSQL races use distinct backend PIDs and an observed advisory lock
wait before releasing the first transaction. SQLite isolation and draining-close
contracts include real Better Auth adapter calls.

The application profile performs real HTTPS email OTP login through `main.mjs`
and Mailpit, restarts the single Entryway instance, then uses `pg_dump` and
`pg_restore` inside the owned PostgreSQL container to restore to a different
database. It verifies the same browser session and DID binding after restore and
checks that no SQLite fallback file exists. Its initial hosted account is a
fixture; this profile does not establish signup, independent migration, replica
failover, or production readiness. Cookies, credentials and dumps remain in
private volumes. Failed profile state is retained with its recorded identity;
successful cleanup targets only that profile's project.

For a standalone profile use `./tests/local.sh database-profile`. It owns a new
`tests/.runtime/postgresql-profile-<run>` checkout and distinct Compose project.
Do not reuse another worker's runtime. Full baseline acceptance remains
`./tests/local.sh fresh`, `./tests/local.sh database-contracts` and
`./tests/local.sh resilience-profiles` after independent review, with the known
raw interoperability moderation blocker reported separately.
