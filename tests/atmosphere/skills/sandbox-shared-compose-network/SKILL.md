---
name: sandbox-shared-compose-network
description: 'Connect a separate Docker Compose project to an existing Atmosphere in a Box closed network without weakening isolation or exposing private state.'
---

# Sandbox Shared Compose Network

Use this skill only when a separate Compose project must join an already running
sandbox network. This is intentionally outside the generator's managed model; do
not use it to add a service that belongs in the primary sandbox. For ordinary
consumer CI workflows, use [sandbox-ci-e2e](../sandbox-ci-e2e/SKILL.md).

## Resolve existing resources first

Read the generated `compose.yaml` and verify the primary project with
`deno task sandbox check` (Deno 2.8.3 CLI). Resolve the physical network and
public-CA volume by their Compose project label; do not assume a default project
name or resource prefix:

```sh
docker network ls --filter 'label=com.docker.compose.project=PROJECT'
docker volume ls --filter 'label=com.docker.compose.project=PROJECT'
docker network inspect NETWORK --format '{{.Name}} {{.Internal}}'
```

Confirm that the chosen network is the sandbox's internal `atmosinabox` network
and that `ca-export` has produced `root.crt`. Obtain the generated DNS address
from the manifest/network layout (base + 3), rather than guessing the default.
Use public connection JSON with a pinned CLI revision. Keep configured resources
separate from running inspection and do not print expanded environments or raw
private state.

`access --json` supplies the physical network, public-CA volume, DNS and HTTPS
gateway as a versioned public projection. It is the preferred input for an
independently owned project; inspection still verifies runtime state.

If the consumer must be reached through the sandbox gateway, first challenge
whether it should instead be a generator-owned managed application stack. Do not
add application-specific routes or static-address overlays to the primary
project from here. Independent projects must keep their own routing contract and
may not rely on the primary gateway resolving their Compose service names.

## Consumer Compose shape

The primary project's physical network is `<project>_atmosinabox`, not a global
`atmosinabox`: project scoping prevents independent sandboxes from sharing a
network and breaking isolation. Never change the primary network's physical name
to simplify joining it.

Declare the resolved resources as external in the consumer project. This is a
pattern only—replace the names and DNS address with inspected values.

```yaml
services:
  app:
    image: example/app
    networks: [sandbox]
    dns: [172.30.249.3]
    environment: { NODE_EXTRA_CA_CERTS: /ca/root.crt }
    volumes: [public-ca:/ca:ro]
networks:
  sandbox: { external: true, name: atproto-sandbox_atmosinabox }
volumes:
  public-ca: { external: true, name: atproto-sandbox_public-ca }
```

The example environment is for a Node consumer. Deno clients use
`DENO_CERT=/ca/root.crt`; the sandbox's internal Deno runner already supplies
it. The consumer's external Compose file remains a native Compose escape hatch,
not a sandbox CLI overlay `--file` option.

Attach no other network and publish no host ports unless the user explicitly
asks to change the isolation boundary. Use `:ro,z` on SELinux hosts for every
bind-mounted consumer secret; a mode-restricted file without the relabel can be
unreadable to a non-root container even when its Unix permissions look correct.
The external consumer must use the sandbox CoreDNS address and public root
volume; Docker network attachment alone does not provide AT Protocol hostname
resolution or TLS trust. Never mount the private Caddy volume, sandbox state, or
PDS secret files.

Validate the consumer with `docker compose -f consumer.yaml config --quiet` and
inspect both projects before deployment. Keep its lifecycle and cleanup scoped
to that consumer project; never use broad Docker pruning or remove the primary
project's external resources.
