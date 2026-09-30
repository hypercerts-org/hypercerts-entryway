---
name: sandbox-ci-e2e
description: Integrate Atmosphere in a Box into a consumer's native CI end-to-end workflow using managed applications or host tests, including preparation, connectivity, artifacts, and project-scoped cleanup.
---

# Sandbox CI end-to-end integration

Use this skill to provision a sandbox and run an existing consumer test suite.
CI owns preparation, tests, artifacts, and cleanup; AiaB owns services, DNS/TLS,
and fixture initialization it actually supports. Read `USAGE.md`, `deno.json`,
and the checked-out CLI help before using commands.

Read [example scope](references/example-scope.md) when adapting the host or
container CI example. For available provisioning interfaces and their CI
constraints, read the relevant parts of
[provisioning extensions](references/provisioning-extensions.md).

## Prepare and provision

1. Pin AiaB separately from the consumer revision. Keep checkout paths and
   command working directories explicit. Install supported Deno and run AiaB's
   `deno task install`; do not install its Node test tooling or run its upstream
   suite in every consumer job.
2. Prepare consumer packages/browser binaries on the host, or build service
   and test images with native Docker tools while network access exists.
   Prepare package-manager shims/caches too; isolated runtime execution must
   not depend on package downloads.
3. Prefer a managed application even when the consumer source is in another
   repository. Copy its Compose source/definition into `stacks/` and append the
   registry entry when absent; reject conflicting entries. Reuse AiaB validation
   instead of asserting unrelated registry entries/order. Follow
   [service templates](../sandbox-service-templates/SKILL.md).
4. Give each job separate checkout/state and project identity. Different project
   names do not isolate jobs sharing `state/`. Use supported subnet selection
   or an explicit nonconflicting manifest; do not assume proposed flags exist.
5. Use `create/check/up`, plus `seed` when needed. Obtain connection information
   through public JSON if implemented, otherwise documented access output and
   targeted configuration inspection. Do not parse expanded environments.

## Run the existing test

For containers, use an already prepared managed test service with ordinary
`docker compose run --rm` and the selected file/project. The consumer owns its
test command, runtime user, writable profile, and report location. The built-in
Deno runner is not an assumed Node/browser test image.

For host tests, follow [client connectivity](../sandbox-tls-browser-trust/SKILL.md)
to adapt DNS/trust to the actual platform. The fixed relay needs local Docker
and port 443; serialize host access or use container execution when appropriate.
Honor the user's chosen mode. Use [external E2E](../sandbox-external-e2e/SKILL.md)
only when a separate Compose project must remain independently owned.

## Native CI lifecycle

Use unconditional provider-native artifact and cleanup steps. Preserve test
failure and report cleanup failures separately. Exercise success and intentional
test failure when validating a recipe; use CI's own cancellation policy. Stop
and remove only the exact job-owned projects, restoring temporary host settings.
`down` retains volumes; disposable runs need project-scoped volume cleanup too.
Never use daemon-wide pruning.

Collect intended consumer reports and redacted diagnostics, not generated state,
credentials, or private CA material. Cache AiaB dependencies by revision,
lockfile, runtime, and platform; consumer packages/browsers by their own versions;
image layers through native build caching. Do not cache mutable sandbox state,
account volumes, or CA private keys.

Report actual project/network/subnet/DNS/HTTPS gateway/endpoints and public CA,
separating configuration from observations and test results. No application
ports are published; the opt-in fixed host relay is the exception. Provisioning
success is not consumer test success; retain required private-PLC proof.

The maintained narrow pattern is [the CI connection example](../../../examples/ci/)
and its [workflow](../../../.github/workflows/ci-example.yml). It uses two
immutable checkout directories, Deno 2.8.3 runtime installation in the AiaB
directory, Node 24, a managed prepared test client, `access --json`, explicit
Compose `run -e` inputs, native artifact upload, and selected-project cleanup.
Build the client image before isolated startup. Cache Deno by revision/runtime/
lockfile/platform and native image layers by client source; never cache state
or volumes. A downstream must provide a published full AiaB SHA rather than
assuming a release tag or `main`.
