---
name: sandbox-fixtures
description: Provision and verify reusable private AT Protocol lexicon fixtures through a managed Atmosphere in a Box authority application.
---

# Sandbox lexicon fixtures

Use this skill when a sandbox application must publish local lexicon records
and private DNS delegation through a real managed PDS. It covers application
fixture declarations and lifecycle, not a consumer's own test framework.

Read `docs/managed-applications.md` before editing a definition. The optional
authority declaration is deliberately narrow:

```json
{
  "authority": {
    "name": "schema-authority",
    "route": "authority",
    "account": { "name": "schemas", "email": "schemas@example.test" },
    "fixtures": [{
      "nsid": "org.example.authWrite",
      "file": "examples/lexicon-fixtures/org.example.authWrite.json"
    }]
  }
}
```

`route` names an exact route. The account handle is one label below that route,
and its effective exact or wildcard route must target the same service and port.
Other selected applications can refer to this authority through a TXT value
`{ "kind": "authority", "authority": "schema-authority" }`.

Fixture files are repository-relative JSON paths with safe nonempty segments;
they cannot be absolute or contain `.` or `..`. Each NSID follows AT Protocol
syntax and is unique without case differences. Apply snapshots the declared
files. A source edit makes configuration stale and `apply` rejects that
immutable fixture change. Seed uses the approved snapshot; a missing or changed
saved snapshot stops seed. Use a fresh sandbox project/state for new fixture
content instead of changing an existing authority.

## Lifecycle

Use the ordinary lifecycle:

```sh
deno task sandbox create --pds 0 --users-per-pds 0 --preset lexicon-fixtures
deno task sandbox check
deno task sandbox up --build
deno task sandbox seed
```

`up` only starts components. `seed` creates or recovers the authority PDS
account, publishes `com.atproto.lexicon.schema` records, recreates DNS from the
committed definition, then verifies TXT, DID, HTTPS, and record readback before
marking fixtures ready. Before seed starts, typed delegations are pending. DNS
activation happens before final checks, so a failed final check can leave
delegation visible but unready; repair the service or DNS and rerun `seed`. It
preserves the original DID and approved records.

Use the configured runner or a managed consumer on the project-scoped internal
`atmosinabox` network, its configured DNS address, and only the read-only public
CA. Consumer and test-client services must not mount private state or the CA
key, publish host ports, add a custom CAR server, or patch generated CoreDNS
files. For a separately owned consumer Compose project, read
[external E2E](../sandbox-external-e2e/SKILL.md).

Test schema/lifecycle changes with `deno task sandbox test` and the Docker
integration suite. Report the selected project/network, internal subnet, DNS,
HTTPS gateway, endpoints, public CA, and whether runtime verification ran.

For a browser or Node consumer of these fixtures, use the managed CI example or
the external-E2E boundary as appropriate. The fixture authority activates TXT
inside the sandbox; it does not itself create host DNS or browser trust.
