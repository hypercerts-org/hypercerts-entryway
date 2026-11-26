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

## Staging a PDS configuration

For operators preparing a host, staging records its configuration and credentials
without associating it or making it eligible for placement. Existing static host
routing remains in effect. A fresh registry-bootstrap authority also supports
explicit operator-attested association for an empty stock PDS. Inbound pairing
remains unobserved. For the stock PDS profile, the public URL must be an HTTPS origin with no path. Entryway uses the canonical URL for transport and OAuth resources and its origin without a trailing slash as the exact PLC service endpoint required by the reference PDS. Previously saved offers and signed operations keep their recorded endpoint.

Mount a protected JSON keyring on every Entryway node and set
`PDS_REGISTRY_KEYRING_FILE` to its path before starting the nodes. The file must
be a regular file, accessible to the service and unreadable and unwritable by
group and others; symlinks to a protected mount are supported. Its format is
`{"activeKeyId":"key-2026","keys":{"key-2026":"<base64-encoded-32-byte-key>"}}`.
Supply keys through your secret manager. Retain every referenced encryption and
request-replay key on every node, including after changing the active key;
startup refuses to serve if a stored reference is unavailable. A key-rotation
operator command is not yet available. Static deployments with no staged
credentials can start without a keyring.

Use the global Entryway administrator password in a protected file with mode
`0600`. Prepare a second protected file containing the stage request as JSON:

```json
{
  "host": {
    "hostId": "pds-new",
    "serviceDid": "did:web:pds.example.org",
    "publicUrl": "https://pds.example.org",
    "internalUrl": "https://pds.internal.example.org",
    "order": 10,
    "stagedIncomingMigration": false
  },
  "credentials": {
    "outboundPassword": "<PDS-admin-password>",
    "inboundToken": "<32-random-bytes-as-unpadded-base64url>"
  },
  "expectedRevision": 0,
  "idempotencyKey": "<unique-request-id>"
}
```

Generate the inbound token securely and deliver it to the PDS operator through a
protected channel. The global password, existing host administrator credentials,
and the two new credential values must be distinct. Stage and inspect using a
verified HTTPS origin; the CLI reads secrets from the files, never arguments:

```sh
node scripts/pds-registry.mjs stage --url https://entryway.example.org --auth-file /secure/admin --request-file /secure/stage.json
node scripts/pds-registry.mjs status --url https://entryway.example.org --auth-file /secure/admin
node scripts/pds-registry.mjs list --url https://entryway.example.org --auth-file /secure/admin
```

To run an outbound check, mount a second protected JSON file on every node and
set `PDS_REGISTRY_TARGETS_FILE` to its path. Map each exact HTTPS origin to a
nonempty ordered list of approved IP addresses, for example
`{"https://pds.example.org":["192.0.2.10"],"https://pds.internal.example.org":["192.0.2.11"]}`.
The file has the same protection requirements as the keyring. The check dials
the first approved address for each origin, verifies the URL hostname against the
TLS certificate, and does not follow redirects or fall back to DNS. Configure
an explicit PEM CA bundle and set `PDS_REGISTRY_CA_FILE` to its path. Entryway
uses that bundle for these checks instead of ambient system roots. The target
file, CA bundle and fixed verification settings form a fingerprint; changing
that policy makes old receipts unusable. Before changing a host's verifier policy,
inspect the database generation and this node's intended fingerprint, then
explicitly transition it using the displayed values:

```sh
node scripts/pds-registry.mjs policy-status --url https://entryway.example.org --auth-file /secure/admin --host pds-new
node scripts/pds-registry.mjs policy --url https://entryway.example.org --auth-file /secure/admin --host pds-new --revision 1 --expected-generation <current-generation> --fingerprint <intended-fingerprint>
```

The first check initializes generation 1. Later policy or candidate revision
changes require an explicit transition. Each transition invalidates pending and
previous checks, including when returning to an older fingerprint.

Export the public Entryway trust settings for the PDS operator, then check the
exact staged revision after the operator applies them and restarts the PDS:

```sh
node scripts/pds-registry.mjs trust --url https://entryway.example.org --auth-file /secure/admin
node scripts/pds-registry.mjs check --url https://entryway.example.org --auth-file /secure/admin --host pds-new --revision 1
```

The staged revision binds a public manifest fingerprint to both endpoints, the
trust settings, capability claim and credential versions. An absent
`stagedIncomingMigration` defaults to false. A true value is only an untrusted
candidate claim and does not establish staged-migration support.

The check compares the service DID and protected-resource issuer at both public
and internal URLs, then performs an authenticated PDS admin read only when those
checks match. It records a generation, receipt ID, fingerprint and bounded
result for that revision, and returns nonzero on failure. Receipts expire ten
minutes after the check starts. A new check immediately invalidates the previous
result and supersedes an in-flight attempt; a late result cannot replace it. A successful outbound check does not
prove a PDS-originated callback. On a fresh registry-bootstrap authority only,
the operator may separately attest and associate an empty stock host as described
below.

### Associating an empty stock PDS

In a fresh `registry-bootstrap` authority, use `show --host pds-new` with the same URL and admin file to inspect the host DID, both endpoints, manifest fingerprint, check results and expiry. The inbound callback is unobserved. Ask the PDS operator to confirm through your existing relationship that the host is empty, the exact manifest and callback credential version were applied, and the PDS was restarted before the check. The outbound read does not prove emptiness or physical equivalence of the two endpoints.

Only after receiving all four confirmations, prepare a protected JSON file with `revision`, the displayed `receiptId`, a unique `idempotencyKey`, and the four explicitly affirmed fields `emptyStock`, `manifestApplied`, `callbackCredentialApplied` and `restartedBeforeCheck`, each set to `true`. Then run:

```sh
node scripts/pds-registry.mjs show --url https://entryway.example.org --auth-file /secure/admin --host pds-new
node scripts/pds-registry.mjs attest --url https://entryway.example.org --auth-file /secure/admin --host pds-new --request-file /secure/attest.json
```

Attestation alone grants no membership or callback authority. For the separate association, prepare another protected JSON file containing `revision`, the returned `attestationId`, and a unique `idempotencyKey`, then run:

```sh
node scripts/pds-registry.mjs associate --url https://entryway.example.org --auth-file /secure/admin --host pds-new --request-file /secure/associate.json
node scripts/pds-registry.mjs show --url https://entryway.example.org --auth-file /secure/admin --host pds-new
```

The transaction rechecks the receipt, manifest, verifier policy and expiry, requires an empty authority with no product records or conflicting historical aliases, and records the association with placement disabled. The operator's assertion does not establish an observed callback. Exact retries return their original result; use new IDs for new requests. Unknown DID methods and encoded endpoint paths fail closed. Association is unavailable in static mode and does not enable account serving or placement.

For a new host use revision `0`. A retry with the same request ID and identical
input returns the original revision; changed input conflicts. To stage a new
revision, use the current revision and a new request ID. Store these IDs with
the operator's deployment records. The staged credential has no callback or
global administrator authority.

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

### Registry bootstrap authority

Operators preparing a fresh authority can set `AUTHORITY_MODE=registry-bootstrap` with an empty `pds` array in the service configuration. This starts health, readiness and globally authenticated registry administration only; account routes, synthetic clients, product mail and reconciliation workers are absent. A separate worker delivers health notifications. Staging, outbound checks and attestation do not associate a host or enable placement; the separate association operation retains disabled placement.

The authority mode is recorded when the fresh schema is created. Every process must use the same mode when opening that database; missing or mismatched markers fail startup. `AUTHORITY_MODE` defaults to `static`. Changing an existing static authority to registry bootstrap is not supported, and this mode does not provide a production cutover. Use a fresh database and consistent configuration for all participating processes.

### Observing registered host health

In `registry-bootstrap` mode Entryway samples an associated host's public and internal `/xrpc/_health` routes without credentials. The same approved IP allowlist and explicit CA bundle used for registry verification apply; redirects are rejected. Configure `PDS_HEALTH_INTERVAL_MS` (default 10000; at least 1000) and `PDS_HEALTH_TIMEOUT_MS` (default 3000; 100–10000) on each node. Twice the interval plus the timeout must be less than 45000 milliseconds, allowing for a scheduler tick immediately before the database due time. Use matching settings across nodes. Each process probes at most four hosts concurrently and rotates their starting order. For N associated hosts, allow at least `ceil(N / 4) * timeout` plus database and scheduling overhead for a full cycle; if this plus twice the interval approaches 45 seconds, observations can go stale. Add capacity or reduce the host count and monitor freshness; the interval and deadline bounds alone do not guarantee fleet capacity. The database fences duplicate samplers and records the sample start time, outcome and freshness; `show` includes the safe health status. Two successful aggregate observations establish or restore healthy status, three consecutive failures establish unhealthy, and observations expire after 45 seconds. A split result reports which route failed. No health result enables placement or changes lifecycle. Placement integration remains outstanding.

### Health incident notifications

Operators should mount a protected JSON file on every registry-bootstrap node and set `PDS_HEALTH_CONTACTS_FILE` to its path. Use the same file contents on every node, for example `{"fleet":"entryway-ops@example.org","hosts":{"pds-new":"pds-ops@example.org"}}`. The file must be a regular file unreadable and unwritable by group and others, like the registry keyring. Restart each node after updating it. Configure the existing SMTP transport for delivery.

The first failed aggregate health observation opens an incident and creates a durable notice obligation for each role. Further failures while open create no additional opening notice. Two passing aggregate observations close it and create recovery obligations. If both roles have the same normalized email address, one message is sent to that address per transition. A recovery waits until that recipient's opening notice is delivered or permanently failed, and uses its recorded opening recipient. A missing contact remains an unresolved obligation visible through `show`; after the contact is configured and nodes restart, the worker reconciles it.

Health notices use the existing mail outbox but do not share OTP expiry or supersession. Transient rejection and unknown outcomes retry independently with backoff up to five minutes; permanent rejection remains visible as `failed` and requires operator attention. A recovery may still be attempted to that recorded address after a permanent opening failure. A lost SMTP acknowledgement can cause a duplicate even though the intent is deduplicated; delivery is not exactly once. Status exposes roles and states rather than addresses. An independently scheduled database-fenced sweep opens a monitoring-stale incident when an associated host has not produced a completed sample for 45 seconds. A host with no sample uses its association time as the initial deadline. The sweep examines up to 50 hosts per pass and persists its cursor; allow enough capacity for all hosts to be visited within the freshness window. Two later passing samples close the same incident. External monitoring for complete authority outages remains necessary; this worker cannot notify when the authority is unavailable.

The registry database includes an internal lifecycle version and audited transition contract. It checks consumed association evidence and current verifier policy, requires a fresh both-pass health result to enable, and conservatively refuses retirement whenever product authority records remain. The selection contract orders eligible candidates by configured order and host ID and rejects an ineligible explicit target. After activation, global administrators can issue lifecycle commands through the protected CLI. Retirement stops new health probes and stale-monitoring checks; prior incident records remain visible. Unknown retained journals, reservations and custody evidence block retirement and further association until their host references can be reconciled. For a newly completed registry signup, the guard can identify the original host from its retained signed genesis, reservation, acknowledged target attempts and linked custody evidence, so an unrelated empty host can be associated and retired. Older signup records without that signed evidence remain blocked. This does not classify arbitrary migration or OAuth histories. Independent user-authorized PLC signatures remain available for any destination; signing does not enable or admit a registered host, and retained signing evidence may conservatively block retirement.

For operators, a standalone `reserveSigningKey` request without a DID creates an unbound key obligation on the selected registry host. The public protocol provides no request identifier that can correlate a later retry or account with that allocation. Entryway records each invocation separately; a lost response may therefore leave an uncertain allocation and a retry may allocate another key. Both successful and uncertain dispatched allocations remain retirement blockers. Settling those obligations requires a separately reviewed reconciliation procedure; draining a host does not erase them.

For operators, registry-backed outbound calls authorize the saved host revision against the database verifier-policy generation and the consumed association evidence immediately before dispatch. Each process uses a startup snapshot of its approved target addresses and CA bytes; changing those files takes effect only after restart. The authorization check is the linearization point: a later policy transition prevents new authorizations but does not cancel a request already authorized under the previous generation.

For operators, `scripts/pds-registry.mjs revoke-callback --url <entryway-origin> --auth-file <operator-secret-file> --host <host-id> --revision <revision>` permanently revokes the stored inbound verifier for that exact revision. The command uses global administrator authentication and is safe to repeat. Revocation does not change the outbound PDS password, prove an inbound callback, or grant the host access to administrator routes. The current bootstrap profile provides no host callback authorization route and no live token rotation, overlap, or reactivation command; staging another revision does not activate it. Keep the global operator credential separate from each host's inbound and outbound secrets.

## Activating a fresh registry authority

For operators bringing a fresh, empty registry authority into service, first stage, verify, attest and associate at least one empty stock host. Association leaves placement disabled. Write `{"expectedGeneration":1,"commandKey":"<unique-key>"}` to a protected file and run `node scripts/pds-registry.mjs activate --url <entryway-origin> --auth-file <operator-secret-file> --request-file <request-file>`. The command changes the shared phase once; use `phase` with the same URL and auth file to inspect it. Stop and drain all bootstrap nodes, then restart every node with the same registry keyring, target allowlist, CA and public signing configuration. Old bootstrap processes continue to expose only administration and health until restarted. A fresh registry authority may serve with zero eligible hosts; new placement requests then refuse until an operator enables a healthy associated host.

To enable, drain or retire a host, write `{"command":"enable","revision":1,"expectedLifecycleVersion":0,"commandKey":"<unique-key>"}` to a protected file and run `node scripts/pds-registry.mjs lifecycle --url <entryway-origin> --auth-file <operator-secret-file> --host <host-id> --request-file <request-file>`. Use the current revision and lifecycle version shown by `show`; replace `enable` with `drain` or `retire` as appropriate. Enable requires fresh passing health checks and matching consumed trust evidence. Drain immediately stops new placements while retained accounts and operations keep their saved target. Retirement refuses known or unmapped retained references. Host callback credentials do not grant global administrator access. This fresh-authority procedure does not convert an existing static deployment.
