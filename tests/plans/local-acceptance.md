# Local acceptance plan

Status: imported and adapted; execution has not been performed in this repository.

## Preparation

Use Docker with Compose v2 (`up --wait` support), Deno 2.8.3, Node 24, Git, Python 3, Bash and flock.

The main repeatable command is `./tests/local.sh fresh`. It clones pinned AiaB
into a unique temporary directory, uses an automatically selected subnet and
a unique project name, runs the complete ordered flow, then removes that exact
project and its volumes. Set `ENTRYWAY_E2E_KEEP_FAILED_STATE=1` to retain failed
state for diagnosis. Reports stay under `tests/artifacts/<project>/`.

For persistent debugging:
Run `./tests/local.sh prepare`, then `./tests/local.sh up`. Preparation downloads
Deno dependencies and image builds install pinned npm packages. Runtime services
and browser clients run inside Atmosphere in a Box with private DNS/TLS.

The persistent default project is `hypercerts-entryway`; the network is project
scoped and `prepare` selects the subnet automatically. The manifest contains
a fallback subnet but the CLI override governs generated state.
No host port or DNS changes are required. Mailpit captures sandbox SMTP.

## Ordered acceptance

1. `./tests/local.sh browser`: original registration, account, managed-PDS move,
   experience, public browser OAuth and access lifecycle journeys.
2. `./tests/local.sh contracts`: imported Node cases, including integration
   assertions consuming identities created by the browser run.
3. `./tests/local.sh migration`: fresh synthetic external source, verified
   destination owner, custody handoff, journal pauses/restarts, target checks
   and post-migration OAuth.
4. `./tests/local.sh resilience`: explicitly disrupt Entryway, then restart the
   core stack with volumes retained. Run alone and last; verify token/resource
   behavior during outage, restore service and check persistent identity/data.

`./tests/local.sh all` performs preparation and that order on fresh fixture state.
It is not a reset command. A completed fixture is revisited with
`./tests/local.sh reverify`; a reviewed interrupted migration can use
`./tests/local.sh migration-resume`. Errors stop the flow; manual recovery is
never invoked automatically. `./tests/local.sh down` retains state and volumes.

## Evidence and boundaries

Reports/screenshots are under `tests/artifacts/`. Keep generated configuration,
private credentials, CA keys and volume data out of commits. The external flow
uses a privileged synthetic source adapter; it does not prove compatibility
with goat or PDS MOOver. Earlier browser cases read the test outbox directly;
newer experience cases use Mailpit. No imported prior results are included.

Use `fresh` for a clean replay. Persistent lifecycle commands never reset existing
accounts implicitly. Only the explicitly disposable `fresh` command removes its
own volumes during cleanup.
