# Working on Entryway

## Product boundaries

This repository is self-contained. Keep source, architecture and test instructions usable without sibling checkouts. Link the published
Lexidraw diagrams for original product-design references; retain relevant findings
in repository-owned documents rather than pointing readers at local spike paths.
Project-specific acceptance matrices belong in the linked Linear document; keep
a reference in the repository instead of a duplicate ticket-linked matrix.

Build a small Entryway for multiple unchanged Bluesky reference PDS instances.
Email OTP and ePDS login behaviour are in scope. Google/GitHub OIDC is roadmap
work excluded from initial delivery. Scaling, balancing and failover are in scope
for resilience. The database target is SQLite and PostgreSQL through Drizzle ORM
`1.0.0-rc.4`: single-node operation supports SQLite or PostgreSQL; multi-node
operation requires PostgreSQL. The async Drizzle boundary, shared operation
ownership and deployment lifecycle are implemented. See [database configuration](docs/database.md),
[shared operations](docs/shared-operations.md) and
[deployment profiles](docs/deployment-profiles.md) for behavior and limits.
Code refactors require neither backward compatibility nor existing-data upgrades.
Public account migration and existing ePDS deployment conversion remain in scope.
Use the existing PDS Entryway hooks and XRPC contracts. Do not fork, patch, or
replace PDS behaviour to make an Entryway test pass. Independent migration with
existing tools is a release requirement, not an operator-only fallback.

Read [architecture](docs/architecture.md), [custody](docs/data-custody.md),
[reuse assessment](docs/reuse-assessment.md), and [testing](docs/testing.md)
before changing cross-domain behaviour.

## Repository layout and ownership

```text
src/
  features/          One operation, its routes, pages and tests in each feature
  authentication/    Browser proof/session port and Better Auth implementation
  mail/              Sending port, SMTP, templates and durable delivery
  database/          Persistence ports, Drizzle adapters and fresh schemas
  accounts/          Shared account values, validation and proof primitives
  pds/               Concrete PDS clients
  plc/               Concrete PLC clients and authorized signing
  oauth/             Shared concrete protocol/legacy-credential helpers
  http/              Shared credential verification and HTTP helpers
  ui/                Shared rendering, forms and branding
  compose-*.mjs       Explicit feature assembly; no business workflows
  app.mjs            Middleware and route registration
  main.mjs           Startup, workers and shutdown
  config.mjs         Process configuration
```

A feature owns its operation, HTTP/XRPC handlers, page and co-located tests.
Features do not import another feature's internals. Composition passes the
specific shared operations needed by multiple journeys. Start at the feature
named for the change: email-login, account-registration, account-settings,
account-deletion, handle-change, account-recovery, oauth-authorization,
connected-apps, external-migration or pds-migration.

Keep ports/adapters only for browser authentication, mail sending and database.
Use concrete PDS/PLC/provider clients, not additional renamed service ports.
Mail retry/outbox state belongs to delivery/database; its transport port sends a
fully formed message. Better Auth never becomes the AT Protocol identity model.
Features receive normalized browser principals, never provider session objects.

Name tables, database files and variables for their purpose, without project-name
prefixes. Preserve names mandated by upstream protocol or provider contracts.

New TypeScript is strict and uses unknown for untrusted input and stable error
codes. Preserved MJS is deliberately not a claim of completed TypeScript coverage;
its owner inventory is docs/source-ownership.json. Do not add matching domain,
port, adapter and index scaffolding to every feature.

The DID is the primary account identity. Keep email claims, identity mapping and
Better Auth schema changes atomic in the reviewed database authority helper.
Support asynchronous transactions without dividing authority changes into separate commits.
Never replace a transaction with sequential provider API calls. Shared account
facts have one owner; another feature cannot mutate a private workflow journal.
Private signing material stays in concrete signing closures, never account
objects, pages, logs or HTTP payloads. Never infer DID ownership from email alone.

Pure rules/state machines cannot import HTTP or SQL. The architecture checker
resolves TS/MJS, aliases, static/dynamic imports and require, rejects cross-feature
imports and cycles, and enforces the three boundaries. The two type-only concrete
source-fixture references in external migration and synthetic client composition
are explicit test integration exceptions; they establish no standard-tool support.

Coordinate shared contract, transaction, identity custody and schema changes.
Use explicit ownership for shared composition and boundary files.
Read applicable tests/plans and tests/flows before changing behavior.

## Runtime and validation

All dependency installation, builds, application execution and tests run through
Atmosphere in a Box. Host work is source editing, read-only inspection, Git and
sandbox lifecycle orchestration, including disposable tooling checkout. Follow `docs/testing.md`; do not run host npm
installs, builds or tests. Use a pinned disposable Atmosphere in a Box checkout and repository-owned stack
templates, following the sibling ePDS harness boundary. Keep installation and
runtime phases explicit. Obtain connection information through `sandbox access
--json`; reports must exclude generated secrets. Use Mailpit for sandbox delivery. Keep TLS verification
on and isolate sandbox projects and state. Do not stop another worker's sandbox.

Run tests when the task requests implementation verification or testing. Report
what ran, the exact result, and what remains unrun. A historical spike report or
presence of a test file is not a current passing result. Do not mark standard-tool
migration complete from a private fixture endpoint or direct database setup.

## Shared repository and agents

Use separate worktrees and short branches. Give each agent explicit file/domain
ownership, accepted contracts and a bounded outcome. Workers are not alone:
preserve others' edits and coordinate shared files. Both developers review changes
to public contracts, storage migrations, identity custody and protocol semantics.
Agents may propose policy; they must not silently invent it to unblock coding.
Keep reviews and integration continuous; do not defer branch integration to week six.

## Secrets and artifacts

Never commit credentials, session/token dumps, OTP captures, private keys, generated
runtime configuration, databases, sandbox state or browser profiles. Log stable
operation IDs and safe error codes rather than request bodies or personal data.
Record provenance for imported code and distinguish reusable code, unfinished
implementation and unresolved integration behaviour.

## Release notes and documentation

Add a named Changeset for operator-visible behavior, configuration or recovery
changes, following [.agents/skills/writing-changesets/SKILL.md](.agents/skills/writing-changesets/SKILL.md).
Use the managed authoring/status/version commands in [RELEASING.md](RELEASING.md);
writing a note does not itself authorize applying a version or making a release.
Internal refactors, tests and prose alone do not require a Changeset.

Keep lasting design rationale in existing architecture or domain docs. Do not
create a separate evidence folder or task-completion reports, scanner triage,
agent ledgers, acceptance tables, generated source/hash inventories or per-run
results. Report validation in PR checks, comments or the final handoff; keep raw
private artifacts in ignored `tests/artifacts/` and working plans local. Preserve
source provenance in the reuse assessment or harness provenance guide.
