# Consumer Compose guide

Use the sandbox as private test infrastructure when an independently owned
project needs a PLC directory, private DNS, and a trusted test CA. The consumer
keeps ownership of its PDS and test suite.

Start a fresh sandbox before the consumer project:

```sh
deno task sandbox create --pds 1 --users-per-pds 0
deno task sandbox check
deno task sandbox up --build
```

Preserve configured domains. Default PLC/PDS names use `.test`; current hosted
OAuth fixtures use `.internal` because upstream validation rejects `.test`
client IDs. Adapt example URLs to the actual manifest.

Before starting the consumer, inspect the generated resources. Do not assume a
project name, physical network name, CA-volume name, or DNS address:

```sh
docker network ls --filter 'label=com.docker.compose.project=PROJECT'
docker volume ls --filter 'label=com.docker.compose.project=PROJECT'
docker network inspect NETWORK --format '{{.Name}} {{.Internal}}'
```

Confirm that `NETWORK` is the internal `atmosinabox` network and that the public
CA certificate has been exported. Obtain the DNS address from the generated
manifest/network layout, or public connection JSON if the pinned CLI supports it.

Replace every all-caps value below with an inspected value. The PLC environment
variable is an example; use the variable supported by the PDS under test.

```yaml
services:
  pds-under-test:
    build: .
    networks: [sandbox]
    dns: [SANDBOX_DNS_IP]
    environment:
      PLC_URL: https://plc.atmosbox.test
      NODE_EXTRA_CA_CERTS: /ca/root.crt
    volumes:
      - sandbox-public-ca:/ca:ro

networks:
  sandbox:
    external: true
    name: PROJECT_atmosinabox

volumes:
  sandbox-public-ca:
    external: true
    name: PROJECT_public-ca
```

Deno consumers use `DENO_CERT=/ca/root.crt`. Mount only the public certificate
read-only; never mount sandbox `state/`, service environment files, or the
private CA key. Keep the consumer on this one network and publish no host ports
unless the requested test intentionally changes the isolation boundary.

This lets the PDS under test reach `https://plc.atmosbox.test`. If sandbox
services or browser tests must reach that external PDS via canonical HTTPS, the
PDS needs its own DNS and TLS route. An external Compose project cannot add a
route to the sandbox gateway; use a managed sandbox application when that route
is required.

For CI, use separate state and a fresh Compose project/subnet per job. Follow
[the CI integration skill](../../sandbox-ci-e2e/SKILL.md) for dependency
preparation, artifacts, and failure-safe cleanup. Bring down the consumer
first, then remove only sandbox resources created by that job. Do not upload
generated state, browser profiles, HAR files, or unredacted logs as artifacts.
