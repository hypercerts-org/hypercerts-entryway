---
name: sandbox-service-templates
description: 'Add or modify Atmosphere in a Box managed Compose applications, definitions, presets, secret declarations, and fixture provisioning.'
---

# Sandbox Service Templates

Use this skill for changes to built-in `compose/*.yaml`, developer managed
`stacks/*.yaml` and `stacks/*.definition.json`, `stacks/components.json`,
`stacks/presets.json`, or the generated service model in Atmosphere in a Box. Do
not use it just to operate an already-rendered sandbox.

## Preserve template ownership

- Inspect `stacks/components.json`, the target Compose source/definition, and
  `lib/compose.mjs` before changing a stack. This is the sole ordered registry;
  its `file` and `definition` entries resolve from the repository root, not the
  registry directory. Keep built-in networking, PLC, PDS, and runner templates
  in `compose/` and start with `networking`; new stacks may only be
  appended—never reorder or remove existing entries.
- Templates may have only `services`, `volumes`, `networks`, and root `x-*`
  defaults. The generated unified Compose file does not support `extends` or
  `include`. All template paths resolve from the eventual `compose.yaml` root,
  not from the template directory.
- The networking stack alone declares the shared root `atmosinabox` network.
  Managed application templates must not redeclare it under root `networks`;
  attach services with `networks: [atmosinabox]`. Keep the physical name
  project-scoped (`<project>_atmosinabox`), never global `name: atmosinabox`, to
  preserve isolation between projects.
- Resource names must be unique across every stack. Keep replicated PDS data
  volumes project-scoped: do not give `pds-data` an external or physical name.
- Optional developer-facing services belong in generator-owned managed
  application stacks, not hand-maintained external Compose wrappers. Register
  the native template as an optional stack, use its closed descriptor for
  private routes, generated configuration, and generated secrets, and expose
  activation through the sandbox CLI. Use an external project only for a
  genuinely independent ownership boundary.
- Edit source templates, never managed regions or hashes in `compose.yaml`.
  Native additions outside managed markers are preserved, but they are trusted
  Compose—not a sandbox extension API.

## Application preset contract

- `stacks/presets.json` maps names to closed objects
  `{"applications":["app-id",...]}`. Document available presets from the
  registry; they are examples of application combinations, not topology
  settings.
- `--preset NAME` is supported only by `create` and full `apply`. It selects
  applications only, never counts, URLs, or topology overrides. Reject its use
  with `--manifest`, `--component`, `--resume`, or any other command.
- Preset apps form an ordered union with repeatable `--app`. Render preserves
  existing apps append-only. Builtins are always included, and registry order
  controls generated output regardless of selection order.
- Unknown names and malformed presets fail before generation. Resolve selection
  to normal manifest apps, not a live preset reference, so later preset edits do
  not silently change existing manifest. Resume uses the approved journal
  without template lookup.
- Read `docs/managed-applications.md` and `USAGE.md` for authoring and
  activation; preserve identity guards and recovery behavior. Perform rendering
  and lifecycle operations within the user's requested task scope.

## Secrets, fixtures, and zero built-in PDS instances

Use `pds: []` when included applications provide the only PDS infrastructure.
This creates no built-in PDS services, volumes, or accounts. The runner still
checks private DNS and verified PLC HTTPS, while built-in account smoke coverage
is visibly skipped.

Reuse the existing secret map, environment/file delivery, and apply journal.
Preserve old byte-secret declarations when adding a typed generator; changed
normalization must not accidentally invalidate persisted application identity.
Test real key import/signing and persistence, not just JSON shape.

For a lexicon authority declaration and its lifecycle, read
[sandbox-fixtures](../sandbox-fixtures/SKILL.md). It uses a real managed PDS,
snapshotted local records, and seed-driven DNS activation. Keep consumer
assertions separate from generic fixture readiness; do not add executable hooks
or a provisioning scheduler.

## Render safely

1. Use the Deno 2.8.3 CLI (`deno task install` for dependencies). Run
   `deno task sandbox status`; resolve a pending journal with `resume` rather
   than regenerating state.
2. Make the smallest Compose source/manifest change. Use `apply --component ID`
   only for an existing stack or the next pending appended stack; manifest
   changes require a full apply.
3. Review warnings before repeating a refused apply with `--accept-destructive`.
   Storage, port, and network warnings signal future detachment or exposure
   risk, not permission to deploy.
4. Run `deno task sandbox status`, `deno task sandbox check`, and focused tests.
   Run `deno task sandbox test`; use `deno task sandbox test --integration` for
   changes to lifecycle, networking, rendered configuration, or PDS behavior
   when its Docker prerequisites are available.

Node 24 and `npm ci` are still needed for Node test tooling, not the Deno CLI or
internal runner. `deno task test` delegates to the CLI test command. Use
`deno task sandbox up --build` only when authorized (wait is the default);
`down` retains volumes. Native Compose remains the escape hatch for overlays,
diagnostics, and migrations, not a CLI overlay `--file`, `logs`, or `reset`
feature. For consumer CI preparation and test execution, use
[sandbox-ci-e2e](../sandbox-ci-e2e/SKILL.md).

Never print expanded configuration or add state/env files to commits: they can
contain credentials. Rendering writes configuration; it does not demonstrate
that services are running or reachable.

The small `examples/ci` application is a reference managed client: it declares
exact/wildcard routes and literal TXT, receives public CA/DNS wiring through the
normal application path, and has no published ports. Keep test-specific host
DNS and browser trust outside the application template.
