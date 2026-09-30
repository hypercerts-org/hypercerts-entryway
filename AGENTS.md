# Working on mini Entryway

## Product boundaries

Build a small Entryway for multiple unchanged Bluesky reference PDS instances.
Email OTP and ePDS login behaviour are in scope; Google/GitHub sign-in is not.
Use the existing PDS Entryway hooks and XRPC contracts. Do not fork, patch, or
replace PDS behaviour to make an Entryway test pass. Independent migration with
existing unmodified tools is a release requirement, not an operator-only fallback.

Read [architecture](docs/architecture.md), [custody](docs/data-custody.md),
[reuse assessment](docs/reuse-assessment.md), and [testing](docs/testing.md)
before changing cross-domain behaviour.

## Repository layout

```text
packages/
  entryway-core/src/{accounts,identity,access,pds-fleet}/
  entryway-service/src/             Adapters, infrastructure and workflows
  entryway-service/src/compatibility/  Transitional MJS runtime
  entryway-web/src/features/        Accounts and Access page composition
tests/
  atmosphere/                      Consumer-owned sandbox orchestration/templates
  contracts/                       Contract/unit scenarios
  browser/                         Browser scenarios
  fixtures/                        Synthetic clients/source fixtures
  plans/                           Acceptance plans and evidence expectations
  flows/                           Cross-component flow definitions
  local.sh                         Local sandbox entry point
scripts/                           Build and structural checks
docs/                              Architecture, custody and delivery guidance
```

Read the applicable `tests/plans/` and flow definition before changing behaviour.
Preserve the small single-process deployment and durable database/worker model;
domain boundaries do not require separate deployed services.

## Domain and adapter rules

- Slice by Accounts, Identity, Access and PDS fleet. Registration and migration
  coordinate domains; they are not a reason to duplicate account authority.
- Core owns domain types, pure rules and ports. Service owns HTTP/XRPC handlers,
  provider integrations, signing and storage adapters. Core must not import
  Express, Better Auth internals, OAuth-provider persistence or SQL clients.
- Use port/domain modules for policy; focused reader/transactor interfaces for
  stored resources. Keep public exports small and dependencies explicit.
- Use strict TypeScript for new code, `unknown` for untrusted input and stable
  domain error codes translated at the HTTP boundary. Existing MJS is transitional
  runtime code, not a completed typed architecture.
- Validate configuration at composition. Prefer distinct named operations over
  boolean mode flags. Keep handlers thin and dependency direction visible.
- The DID is the primary account identifier. Better Auth user IDs and browser
  sessions are separate identifiers. Do not add an account UUID without a
  documented need and migration design.
- Preserve atomic identity/email binding and claim updates. Do not replace an
  atomic adapter operation with several unrelated provider API calls. Isolate
  pinned Better Auth schema access behind an explicit adapter and contract tests.
- Keep repository signing keys in the PDS. Identity signing goes through a port;
  private key material does not belong in domain objects, logs or HTTP payloads.
- Never identify incoming DID ownership from email alone. Custody and repository
  placement are separate decisions.

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

