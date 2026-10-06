# Acceptance plans

Main repeatable command: `./tests/local.sh fresh`. See [local acceptance](local-acceptance.md)
for the current order and [the October 5 baseline](baseline-2026-10-05.md) for two
isolated, source-matched runs at `89589ca6`. Publishing this inventory on October 6
did not claim a new application run or complete release acceptance. The subsequent
[purpose-based naming verification](naming-2026-10-06.md) records fresh execution
after the storage and configuration rename.

The project-specific matrices are maintained in the [Linear M1 acceptance document](https://linear.app/hypercerts/document/m1-acceptance-matrices-epds-parity-protocol-and-migration-196f21e01e71), linked from all five M1 issues and the milestone. It contains 38 ePDS parity rows, 43 XRPC/coordination rows, 8 OAuth rows, 25 migration rows, the 152-scenario ePDS index, source pins and decision owners. Use that document for ticket-linked requirements and approvals; do not maintain a second matrix copy here.

The [baseline report](baseline-2026-10-05.md), committed [receipts](../../plans/evidence/), source and harness remain in this self-contained repository. Original design references are the [published Lexidraw diagrams](../../docs/README.md#core-design-references). No sibling Entryway checkout is needed.

| Domain | Flow | Existing assertions | Repeat strategy |
| --- | --- | --- | --- |
| Accounts / Access | [OTP and client OAuth](../flows/otp-client-oauth.md) | Signup, returning login, consent, browser OAuth, expected DID, write and refresh | Fresh isolated project; most ordinary cases generate unique accounts |
| Accounts / Access | [Account and device lifecycle](../flows/account-device-lifecycle.md) | Account settings, email proof, devices, session/grant controls | Serial cases with dedicated accounts; no shared operator accounts |
| Identity / PDS fleet | [External migration](../flows/external-migration.md) | Fixture source, custody transition, data integrity, restart/resume, subsequent login | One source identity per project; use reverify only for completed state |
| Runtime / Access | [Resilience](../flows/resilience.md) | Entryway outage and persistent core-stack restart | Last, alone, after live browser sessions exist |

Unit and contract cases remain in `../contracts/` and beside feature operations;
real browser interactions remain in `../browser/`. Their existence is not evidence
of passing runs; use the linked source-matched receipts.
Independent existing-tool migration, fleet drain/retire, and production custody
operations are not established by these imported scenarios.
