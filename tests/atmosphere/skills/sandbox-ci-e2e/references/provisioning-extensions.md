# Shipped provisioning extensions

Atmosphere in a Box provides the provisioning interfaces below. Inspect
the current CLI help, selected manifest, and documented runtime evidence before relying
on an interface. Consumers register their application sources and own test
orchestration through native CI and Compose.
Never edit generated state to substitute for a supported workflow.

| Capability | Interface | CI implication |
| --- | --- | --- |
| Subnet selection | `create --project`, `--subnet auto`, `--subnet-pool` | Persist the selected concrete subnet; use an explicit subnet for remote/offline Docker. |
| DNS routes | Exact and one-label wildcard application routes; literal or authority TXT | Wildcard patterns are not host-file entries or probeable URLs. |
| Fixtures | `authority` declaration and `sandbox seed` | Run seed and keep consumers on internal DNS plus public CA. |
| Access examples | [`examples/ci`](../../../../examples/ci/) host and managed-container probe | The documented Fedora/local-Docker recipe is narrow; validate adaptations separately. |
| Zero PDS | `pds: []` | Expect direct infrastructure smoke and explicitly skipped built-in accounts. |
| Connection JSON | `access --json` | Consume configured addresses and observations without parsing generated state. |
| ES256 secrets | `{ "jwk": "ES256" }` declaration | Deliver through generated private env/file only; public JSON excludes it. |
| Native CI | [CI connection workflow](../../../../.github/workflows/ci-example.yml) | Pin two source revisions, upload public artifacts, and clean only the selected project. |

## Fixture consumer sequence

An authority is optional application infrastructure, not a built-in PDS. After
`create`, `check`, and `up`, run `seed`. The seed process recovers its saved
authority account, publishes the snapshotted records, recreates DNS, and
verifies TXT, DID, HTTPS, and PDS record reads. A typed authority TXT reference
is pending before seed starts; DNS activation can precede final verification. A
retry after a final verification failure converges without changing the saved
DID or fixture content.

For the declaration, source-path, and recovery rules, read
[sandbox-fixtures](../../sandbox-fixtures/SKILL.md). A real downstream consumer
should retain its own native Compose tests and use the public CA/DNS information
from `access --json`; it must not reintroduce custom authority, DNS, or CA
workarounds.
