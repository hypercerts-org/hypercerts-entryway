---
name: sandbox-external-e2e
description: Connect an independently owned PDS or client Compose project to Atmosphere in a Box for isolated end-to-end tests with the sandbox PLC, DNS, and public CA.
---

# Sandbox external end-to-end tests

Use this skill when a separate project needs the sandbox's PLC and private
network for its own end-to-end tests. Do not use it to add an application that
belongs to the sandbox itself; that should be a managed application stack.
For normal consumer CI integration, including a consumer in a different source
repository, start with [sandbox-ci-e2e](../sandbox-ci-e2e/SKILL.md). Repository
separation alone does not require independent Compose ownership.

Read [the consumer Compose guide](references/consumer-compose.md) before
changing a consumer Compose file. For a complete CI lifecycle example,
read [the CI connection workflow](../../../.github/workflows/ci-example.yml).
The provider files below are setup skeletons for independently owned Compose
projects and are not portable consumer test commands:

- [GitHub Actions](references/github-actions.yml) for a Linux GitHub-hosted
  runner with Docker.
- [Tangled Spindle](references/tangled-spindle.yml) for a `microvm` workflow
  with Docker enabled.

## Required boundary

- Start a fresh sandbox first. Inspect its actual Compose project, internal
  `atmosinabox` network, public-CA volume, and DNS address; never assume their
  physical names.
- In the consumer Compose project, declare that network and CA volume external,
  set the sandbox DNS address, and mount only `root.crt` read-only. Node clients
  use `NODE_EXTRA_CA_CERTS`; Deno clients use `DENO_CERT`.
- Keep the consumer project independently owned. Do not mount sandbox `state/`,
  generated service environment files, or the private CA key. Do not add routes
  or static-address overlays to the sandbox's generated Compose project.
- Preserve configured sandbox domains. For hosted OAuth metadata, use a name
  accepted by the pinned client/PDS validators; the current fixtures use
  `.internal` because upstream validation rejects `.test` client IDs.

## CI

Use separate sandbox state and a fresh Compose project/subnet per job. Prepare
dependencies and browsers before isolated runtime execution; install AiaB's
Deno runtime dependencies separately from consumer packages. Limit cleanup to
resources carrying that job's project name, and do not upload secret-bearing
generated state or raw diagnostics. A Docker-dependent Tangled workflow needs
the `microvm` engine with Docker enabled; the Nixery engine is not sufficient.

If a consumer needs its PDS reachable by the sandbox through a canonical HTTPS
hostname, stop and choose a managed sandbox application or a separate DNS/TLS
front door. An external Compose project cannot extend the sandbox gateway.
