# Hypercerts Entryway

An Entryway for multiple unchanged Bluesky reference PDS instances. It moves
ePDS email OTP authentication into the PDS's supported Entryway boundary and
provides account management, authorization and identity operations.

This repository is self-contained. Application source, sandbox orchestration,
architecture and acceptance documentation live here; no sibling Entryway checkout
is required. External repositories and [Lexidraw designs](docs/README.md#core-design-references)
are references, not runtime or documentation dependencies.

**Status:** one application organized by vertical features. Ports/adapters are
limited to browser authentication, mail sending and database. Preserved MJS is
owned by its feature; standard-tool migration, moderation coordination and fleet
registry remain product gaps. The target also requires Drizzle ORM `1.0.0-rc.4`
with SQLite or PostgreSQL for single-node operation, PostgreSQL required for
multi-node operation, and
scaling, balancing and failover for resilience; these
are not implemented by the current SQLite baseline. Google/GitHub OIDC is roadmap
work excluded from initial delivery.

## Start the sandbox

Install Docker Compose v2, Node.js 24, Deno 2.8.3, Python 3, Git, Bash and `flock`
on the host. Application dependencies, builds and tests run in containers. Host
Node/Python support sandbox orchestration; do not run application npm commands
on the host.

For a repeatable isolated acceptance run:

```sh
./tests/local.sh fresh
```

`npm run test:e2e:atmosphere` is an optional alias for shell orchestration. It does
not install or run the application on the host.

The harness creates a disposable pinned Atmosphere in a Box checkout, chooses an
automatic subnet, installs this repository's stack templates, validates access
metadata, builds images and runs the suites, with disruptive resilience checks
last. It removes its own project and
volumes afterward. Keep failed state for investigation with:

```sh
KEEP_FAILED_SANDBOX=1 ./tests/local.sh fresh
```

Reports go to `tests/artifacts/<project>`. Migration in this suite exercises a
private synthetic source helper; it is **not** standard-tool migration acceptance.
For persistent development and selective commands, read [testing](docs/testing.md).
The [published baseline and acceptance matrices](tests/plans/README.md) describe
current evidence and remaining gaps; historical spike passes are not new acceptance.

## Layout

```text
src/features/<feature>/   Operation, routes, pages and co-located tests
src/authentication/       Better Auth browser proof/session boundary
src/mail/                 SMTP sending boundary and delivery
src/database/             Persistence ports, SQLite and migrations
src/accounts/             Common account facts and proof primitives
src/pds/, src/plc/         Concrete protocol clients and authorized signing
src/http/, src/ui/        Shared HTTP and presentation helpers
src/app.mjs               Explicit composition and route registration
src/main.mjs              Startup, workers and shutdown
tests/                    Contracts, browser journeys, fixtures and AiaB harness
```

Features own their operations end to end. Shared authentication,
transactions and custody changes are coordinated; features never import each
other's internals. The source boundary checker enforces this structure.

## Read next

- [Architecture and boundaries](docs/architecture.md)
- [Data model and identity custody](docs/data-custody.md)
- [Reusable code, required work and investigations](docs/reuse-assessment.md)
- [Delivery planning in Linear](docs/delivery-plan.md)
- [Testing and evidence limits](docs/testing.md)
- [Agent and contributor rules](AGENTS.md)

## Provenance

The application and Atmosphere in a Box harness were imported from the Entryway
spike. The ePDS harness supplied the design pattern for disposable pinned checkouts,
consumer-owned stacks, access metadata and scoped cleanup. Imported implementation
and the required templates are now owned by this repository; earlier spike/replay
trees are historical provenance, not additional runtime packages.
Reference PDS behaviour is grounded in Bluesky's source and Entryway tests; no PDS
fork is part of this repository. See the reuse assessment for source evidence.
