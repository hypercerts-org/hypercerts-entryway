# Acceptance plans

Main repeatable command: `./tests/local.sh fresh`. No current execution result
is recorded by importing this harness. See [local acceptance](local-acceptance.md).

| Domain | Flow | Existing assertions | Repeat strategy |
| --- | --- | --- | --- |
| Accounts / Access | [OTP and client OAuth](../flows/otp-client-oauth.md) | Signup, returning login, consent, browser OAuth, expected DID, write and refresh | Fresh isolated project; most ordinary cases generate unique accounts |
| Accounts / Access | [Account and device lifecycle](../flows/account-device-lifecycle.md) | Account settings, email proof, devices, session/grant controls | Serial cases with dedicated accounts; no shared operator accounts |
| Identity / PDS fleet | [External migration](../flows/external-migration.md) | Fixture source, custody transition, data integrity, restart/resume, subsequent login | One source identity per project; use reverify only for completed state |
| Runtime / Access | [Resilience](../flows/resilience.md) | Entryway outage and persistent core-stack restart | Last, alone, after live browser sessions exist |

Unit and contract cases remain in `../contracts/`; real browser interactions
remain in `../browser/`. They are source assets, not evidence of passing runs.
Independent existing-tool migration, fleet drain/retire, and production custody
operations are not established by these imported scenarios.
