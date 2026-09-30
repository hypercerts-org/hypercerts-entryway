---
name: sandbox-network-extensions
description: 'Extend or diagnose Atmosphere in a Box subnet selection, private DNS records, application HTTPS routes, and generated connection information.'
---

# Sandbox Network Extensions

Use this skill when adding an in-project service or overlay that must call or be
called through the sandbox's private AT Protocol network. Read
`compose/networking.yaml`, `lib/components.mjs`, and the closest file under
`examples/` first.

## Network contract

`atmosinabox` is the logical `internal: true` Docker network. Its physical name
remains `<project>_atmosinabox`; never set a global `name: atmosinabox`, which
would break isolation between sandbox projects. Only the networking stack owns
the root network declaration. Managed application templates must attach services
to `atmosinabox` without redeclaring it under root `networks`. The configured
subnet is private `/16`–`/28`; the generator pins gateway to network base + 2
and CoreDNS to base + 3, reserving the upper half for dynamic allocation. Do not
hard-code the default `172.30.249.2`/`.3` after a custom manifest: derive the
addresses from `state/manifest.json` and `lib/components.mjs`.

For an ordinary private client, prefer a managed application, which supplies
network/DNS/CA wiring. For an explicitly chosen overlay, follow
`examples/client.overlay.yaml`: attach only to `atmosinabox`, set `dns` to the
generated CoreDNS address, mount
`public-ca:/ca:ro`, set `DENO_CERT=/ca/root.crt` for Deno or
`NODE_EXTRA_CA_CERTS=/ca/root.crt` for Node clients, and wait for `ca-export` to
complete. Do not publish a host port or mount `state/ca/root.key`. The internal
runner uses Deno and supplies `DENO_CERT=/ca/root.crt`; use
`docker compose run --rm runner deno eval 'console.log((await fetch("https://plc.atmosbox.test/_health")).status)'`
for a default-domain probe, adapting the URL to the manifest. Use
`deno task sandbox check` and `deno task sandbox up --build` for the base
project (startup waits by default). Overlays and arbitrary diagnostics remain
native Compose: use the same `-f compose.yaml -f overlay.yaml` list for every
Compose command, not a sandbox CLI `--file` option.

## Exposing a new private hostname

For an optional service that belongs to this developer scaffold, add a managed
application stack and let the generator own these hooks. Keep its template and
application definition in `stacks/` and append it to the sole ordered registry,
`stacks/components.json`, using repository-relative `file` and `definition` paths
and its `application` ID.
Built-in network templates remain in `compose/`. Follow
`.agents/skills/sandbox-service-templates/SKILL.md` and
`docs/managed-applications.md` for activation with `--app` or application-only
`--preset` combinations in `stacks/presets.json`. Do not default to a
hand-maintained external Compose wrapper merely to add a service. A separately
owned Compose project is an exception for a real independent ownership boundary.
Managed route declarations generate DNS and Caddy configuration together. For
an explicitly chosen native overlay, adding a hostname such as
`records.example.test` needs both hooks and their mounts shown in
`examples/service.overlay.yaml`:

1. Add a Caddy fragment under `/etc/caddy/routes/` with `tls internal` and a
   `reverse_proxy` to the service's network port.
2. Add a CoreDNS zone fragment under `/config/zones/` mapping that hostname to
   the generated gateway address.

Generated `state/Caddyfile` and `state/Corefile` import these directories; do
not edit them. Restart `dns` and `gateway` using that same file list after
deploying the overlay. Custom overlays are trusted native Compose and can defeat
isolation with ports, mounts, privileges, or networks. Validate their combined
configuration with `docker compose ... config --quiet` and inspect source
mounts/networks/ports separately when assessing effects. Test HTTPS through the
named endpoint with the public CA trusted; never work around
trust failures by disabling TLS verification.

## Subnets, wildcard records, and connection output

Read [provisioning extensions](../sandbox-ci-e2e/references/provisioning-extensions.md)
for subnet, DNS, and connection-output constraints. Pin the CLI revision before
using its flags or declarations. Preserve explicit and committed subnets. Inspect
the Docker engine actually used and its host routes, ignoring the default route as
an overlap candidate. Candidate selection is not an atomic allocation; report
a Docker allocation race clearly rather than silently renumbering state.

Generate wildcard DNS and HTTPS from the same declarations. Match one label,
give exact routes precedence, and test apex/deeper/unrelated names and A/AAAA/TXT
queries. TXT owners need validation that accepts `_lexicon`; ordinary HTTPS
hostname validation does not. A provisioned DID reference needs an account
initialization step. Treat route/TXT edits as configuration rather than
accidentally freezing them as application identity.

Keep wildcard patterns distinct from URLs in environment sources, connection
output, and hosts-file entries. Connection JSON must be an explicit public
projection with configured and observed resources separated; distinguish the
Caddy HTTPS gateway from Docker's IPAM gateway and unknown from observed absent.
Do not serialize arbitrary state or expanded service environments.

Use [client connectivity](../sandbox-tls-browser-trust/SKILL.md) for host/browser
adaptation; an HTTPS relay does not supply host DNS. Run unit and applicable
integration tests for networking changes. Report actual project/network names,
internal flag, subnet, DNS, HTTPS gateway, public CA, endpoints, commands run,
and unverified reachability rather than deriving success from container health.
The CI example consumes this projection directly and keeps its temporary host
DNS helper outside the managed project.
