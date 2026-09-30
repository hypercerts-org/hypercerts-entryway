---
name: sandbox-tls-browser-trust
description: 'Diagnose and adapt Atmosphere in a Box connections for host or container Node, Deno, and browser clients, including DNS, the local HTTPS relay, public-CA trust, and cleanup.'
---

# Sandbox TLS and Browser Trust

Use this skill to diagnose sandbox DNS/TLS or adapt a working example to the
user's actual host, container, browser, or CI environment. Read
`compose/networking.yaml`, `lib/components.mjs`, `lib/access.mjs`, and
`USAGE.md` before changing host routing or certificate trust. For platform
adaptation and dynamic names, read
[client adaptation](references/client-adaptation.md). For complete consumer CI
integration, use [sandbox-ci-e2e](../sandbox-ci-e2e/SKILL.md).

## Architecture and boundaries

The logical `atmosinabox` network (physical `<project>_atmosinabox`) has no
published ports or external DNS forwarding. Caddy is pinned at subnet base + 2;
CoreDNS is base + 3. Generated Caddy routes PLC, PDS, and handle names with
`tls internal`. Initial generation creates `state/ca/` with mode `0700`; after
the first gateway health check, `ca-export` saves Caddy's local authority there
as `root.crt` and `root.key`. A supplied PEM pair at those exact host paths is
used immediately on gateway start. The exporter copies only `root.crt` into the
`public-ca` volume. Treat `state/ca/root.key` as secret: never mount, copy,
install, or commit it for a client.

For container diagnostics, the internal runner uses Deno with
`DENO_CERT=/ca/root.crt` supplied by its environment and `public-ca:/ca:ro`. Use
`docker compose run --rm runner deno eval 'console.log((await fetch("https://plc.atmosbox.test/_health")).status)'`
with the actual manifest URL. Node clients still use
`NODE_EXTRA_CA_CERTS=/ca/root.crt`; do not assume Node exists in the Deno
runner. Use `deno task sandbox ps` for container status; arbitrary diagnostics
and public certificate extraction remain native Compose commands.

A host browser needs hostname resolution for the sandbox names, trust for the
exported public root, and the explicit loopback relay. `sandbox access hosts`
prints the needed mappings and `sandbox access start` publishes only
`127.0.0.1:443`. Do not claim browser reachability from container health alone,
add public ports as a workaround, or disable certificate checks.

## Trust workflow

1. Confirm `gateway` is healthy and `ca-export` completed, then validate the
   host-persisted public certificate at `state/ca/root.crt` without exposing its
   paired key. The directory is state-bearing: back it up with matching state
   and keep `root.key` mode `0600`.
2. For concrete names, use `deno task sandbox access hosts` and the generated
   hosts block. A hosts file has no wildcard support. For dynamic names, use
   the resolver procedure in the adaptation reference; do not enumerate handles
   or claim that the relay provides DNS.
3. For Firefox, open **Settings → Privacy & Security → Certificates → View
   Certificates → Authorities**, import the public root, and enable website
   trust. For other browsers, identify the browser/build and use its supported
   trust store/profile. Consult current official documentation for that platform
   rather than assuming OS-store or NSS behavior. Restart when required.
4. Run `deno task sandbox access start`, then visit a sandbox HTTPS endpoint,
   such as `https://pds1.atmosbox.test/xrpc/_health`, and confirm the browser
   shows a valid chain without an exception. Remove temporary exported
   certificate files when finished; remove installed trust only through an
   intentional cleanup within the user's requested scope. Verify Node/Deno and
   browser trust separately; one successful client does not prove the other.

Changing host routes or browser/OS trust persists beyond the sandbox session.
Use existing task authorization; do not ask again for already authorized setup
or cleanup. If a necessary persistent change has unspecified scope, clarify
that scope while continuing read-only diagnosis. Prefer temporary CI profiles
and resolver configuration when supported. Record and remove only changes made
for this task; do not replace shared settings or stop another project's relay.

## Verified Linux CI companion

[`examples/ci/host-probe.sh`](../../../examples/ci/host-probe.sh) is the narrow
Fedora 44/local-Docker implementation for a dynamic-name browser probe. It
requires a prepared Playwright browser cache and explicit executable path, uses a temporary host-network
dnsmasq container on an unused `127.0.0.2:53`, forwards to selected CoreDNS,
aliases only the selected gateway to loopback, and checks UDP, TCP, TXT, and
negative DNS before opening the existing relay. Node and Chromium run in a
private user/mount namespace with temporary NSS trust from the public root. It
neither changes global resolver/trust state nor mounts private state in a
client. Preserve its ownership checks and cleanup rules when adapting it;
remote Docker, Desktop, other operating systems, and other browser profiles
remain unverified.
