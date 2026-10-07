# Deployment lifecycle and profile verification

Entryway supports one process with SQLite or PostgreSQL, and multiple processes
with shared PostgreSQL. `DATABASE_BACKEND`, `DEPLOYMENT_MODE` and `DATABASE_URL`
select these combinations; [database configuration](database.md) rejects shared
SQLite. Replicas need the same canonical issuer, signing configuration and
shared authority database. A process identity identifies one boot, not a durable
node registry. Balancing Entryway requests neither relocates repositories nor
replicates PDS data.

Database-aware admission, worker draining and three consumer-owned profile
controllers are implemented. These managed checks do not establish complete
production resilience or fleet qualification.

## Admission and shutdown

`/_health` reports that the HTTP process is alive. `/_readyz` is a lightweight,
nonsecret ingress probe: it requires completed initialization, usable authority
storage and a process that is not draining. Its response contains status and a
per-boot instance ID. The existing authenticated `/_ready` endpoint retains
operator detail. Readiness failures refuse new application requests with HTTP 503
and `Retry-After: 2`; the browser response explains that this request did not
start and offers a return to the previous page. It does not claim unsent details
were saved. This refusal differs from an already-dispatched account operation's
[durable pending recovery](shared-operations.md).

| Setting                     | Default | Accepted range    |
| --------------------------- | ------- | ----------------- |
| `DATABASE_PROBE_TIMEOUT_MS` | 2000ms  | Integer 1–10000ms |
| `SHUTDOWN_TIMEOUT_MS`       | 15000ms | Integer 1–60000ms |

A database instance has at most one physical probe in flight. SQLite uses its
existing connection gate and a bounded native busy timeout; an expired queued
probe does not join another authority transaction. PostgreSQL uses an owned
one-query connection with bounded acquisition/query work and absolute socket
cleanup, including a peer that withholds graceful closure. Its configured TLS
negotiation remains enabled. Idle pool errors make storage unavailable without
causing an unhandled process error. These probe bounds do not redefine every
ordinary authority query's timeout.

Startup mail retry runs as tracked background work after initialization and HTTP
binding. Mail and reconciliation scheduling coalesce by worker name. On SIGTERM
or SIGINT, Entryway stops new HTTP admission and new worker scheduling, closes
HTTP admission, waits for admitted requests/workers, then closes storage. Repeated
signals share that shutdown. A connection aborted while its readiness check is
pending starts no downstream work. Normal completed request bodies remain valid.
An already-admitted request whose client disappears remains conservatively
tracked; socket closure is not proof that authority work finished.

Successful drain exits 0. The shutdown deadline exits 1 and leaves durable claims
and uncertain external attempts intact. It does not clear ownership or assert
remote cancellation. Run the application directly as `node dist/src/main.mjs`
under a supervisor that forwards signals; the repository container and templates
do this. The account lease remains 120 seconds, with renewal every 30 seconds; mail
claims remain 30 seconds. Existing recovery requirements are unchanged.

## Repeatable profile checks

Run `./tests/local.sh resilience-profiles` through the repository's pinned
Atmosphere in a Box harness. It creates separate fresh projects for SQLite
single-node, PostgreSQL single-node and PostgreSQL two-node, then requires a
complete receipt from all three. Each profile has one canonical TLS issuer.
A consumer-owned test ingress selects actual processes for crossover assertions
and excludes unready processes for ordinary traffic. Its explicit node-selection
header is test machinery, not a production routing or fleet API.

Every profile exercises fresh Mailpit signup, returning OTP/session use,
independent-client OAuth and direct PDS reads/writes. The PostgreSQL replica case
crosses observed boot IDs for OTP completion, session use, code consumption,
refresh/replay and revocation. Concurrent cold client initialization retains the
same public metadata keys across nodes. Safe attempt receipts associate actual
application work with its boot identity; private keys and credentials stay in
private volumes.

Graceful removal and SIGKILL are followed by session/PDS use on the survivor
where one exists, then rejoin. The profiles interrupt the authority PostgreSQL
service; SQLite uses controlled schema-probe unavailability, not a disk-failure
claim. Both paths require refusal, liveness, recovery and a real browser journey
that retains an entered draft through Back and successful resubmission. Desktop,
narrow and keyboard-focus images cover application and ordinary-ingress refusal.

| Bound       | Scope                                                             |
| ----------- | ----------------------------------------------------------------- |
| 8 seconds   | Ingress withdrawal/readiness loss from the recorded fault trigger |
| 10 seconds  | Readiness recovery from the recorded recovery trigger             |
| 20 seconds  | Application stop, including the default 15-second drain deadline  |
| 30 seconds  | Node rejoin and browser/controller coordination marker            |
| 75 seconds  | Mail takeover after held-owner process loss                       |
| 190 seconds | Account reconciliation takeover after held-owner process loss     |
| 195 seconds | Controlled worker case, including teardown                        |
| 480 seconds | Entire profile exercise after managed startup, not each phase     |

Ingress withdrawal is observed concurrently with graceful stopping, since these
have different deadlines. Probe attempts consume the remaining fault budget,
including controller/container startup. An external controller deadline terminates
hung exercise work; a further 5 seconds is allowed for hard controller termination,
and scoped temporary-container cleanup is recorded separately. A timeout remains
a failure. No receipt may turn a late observation into a pass.

The replica worker phase uses distinct OS processes and PostgreSQL connections
with production reconciliation/mail code and default leases. It holds and loses
an owner at deterministic checkpoints, proves takeover and rejects stale
completion. Its transport is controlled: it does not prove upstream PDS fencing
or every application scheduler failure. Uncertain PDS work retains its exact
attempt/target while unrelated accounts progress. SMTP takeover still permits
uncertain duplicate delivery.

Receipts bind source/build/controller inputs, installed pins, configuration
hashes, image/container identities, actual exits and observed process IDs. The
collection verifier rejects a missing profile or a purported two-node profile
with only one process. Failed projects and original failures remain available;
cleanup targets only the selected owned rootless projects. Existing `fresh` and
`database-contracts` gates remain required alongside these profiles.

Fleet eligibility/placement, PDS drain/retirement, complete restore/key coverage
across every deployment combination, standard-tool migration and exhaustive
fault/abuse qualification remain separate work. The existing moderation blocker
and [credential-lifetime defect](implementation-assessment.md#known-limits) remain unresolved. Delivery criteria
live in the [project document](https://linear.app/hypercerts/document/m1-acceptance-matrices-epds-parity-protocol-and-migration-196f21e01e71).
