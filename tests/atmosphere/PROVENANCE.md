# Atmosphere in a Box consumer

Upstream: https://tangled.org/kandake.africa/atmosphereinabox
Pinned revision: `26cf1f60f81b491b065dfc830efd27aba8b89a54` (0.7.0).

Uses the pinned-clone, repository-owned managed stack and validated access
projection pattern from `hypercerts/ePDS/e2e/atmosphere`. Entryway-specific
templates/client examples/skills were imported from the Entryway next-spike
parent commit `f7d3572499efc759f0329330a63010464189ba01`; they are consumer
source and are registered onto the pinned checkout, without patching AiaB
implementation or PDS code. The imported snapshot also included working changes
and later operational tooling; see [import lineage](../../docs/reuse-assessment.md#import-lineage).
Import provenance alone is not acceptance evidence. The [testing guide](../../docs/testing.md)
retains the moderation and independent-migration limits.

The clone and generated state live under ignored `tests/.runtime/`. No original
sandbox state, secrets or prior reports were imported.

## Development: CI lifecycle provenance

For contributors maintaining CI, `scripts/ci.sh` adapts the pinned-checkout,
managed-image, access-projection and scoped-cleanup sequence inspected in ePDS's
`.github/workflows/e2e-atmosphere.yml` and `e2e/atmosphere/run.sh`. The sibling
relay's `scripts/verify.sh` provided the single local/CI verification-entrypoint
pattern. Those checkouts are design references, not runtime dependencies.
Entryway owns its lifecycle manifest, child registration, rootless checks and
container-run failure fixtures; it does not import upstream test suites or modify
PDS behavior. See [local CI commands](../../docs/testing.md#development-automated-ci-checks)
for reproduction, cleanup semantics and evidence limits.
