# Acceptance plans

Main repeatable command: `./tests/local.sh fresh`. See [local acceptance](local-acceptance.md)
for the ordered gates and [testing](../../docs/testing.md) for setup and limits.

The project-specific matrices are maintained in the
[Linear acceptance document](https://linear.app/hypercerts/document/m1-acceptance-matrices-epds-parity-protocol-and-migration-196f21e01e71).
Use it for requirements and approvals; do not maintain a second matrix here.
Source, harness and [published designs](../../docs/README.md#core-design-references)
are usable without a sibling Entryway checkout.

| Domain               | Flow                                                                 | Existing assertions                                                                  | Repeat strategy                                                        |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Accounts / Access    | [OTP and client OAuth](../flows/otp-client-oauth.md)                 | Signup, returning login, consent, browser OAuth, expected DID, write and refresh     | Fresh isolated project; most ordinary cases generate unique accounts   |
| Accounts / Access    | [Account and device lifecycle](../flows/account-device-lifecycle.md) | Account settings, email proof, devices, session/grant controls                       | Serial cases with dedicated accounts; no shared operator accounts      |
| Identity / PDS fleet | [External migration](../flows/external-migration.md)                 | Fixture source, custody transition, data integrity, restart/resume, subsequent login | One source identity per project; use reverify only for completed state |
| Runtime / Access     | [Resilience](../flows/resilience.md)                                 | Entryway outage and persistent core-stack restart                                    | Last, alone, after live browser sessions exist                         |

Unit and contract cases remain in `../contracts/` and beside feature operations;
real browser interactions remain in `../browser/`. Their existence is not evidence
of passing runs; report actual commands, results and source revision in the PR
or final handoff, with raw artifacts kept under ignored `tests/artifacts/`.
Independent existing-tool migration, fleet drain/retire, and production custody
operations are not established by these imported scenarios.
