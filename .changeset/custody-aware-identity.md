---
"hypercerts-entryway": minor
---

- Configure public-only `plcRecoveryKeyDid`, distinct from the hot key. New accounts order optional user recovery, operator offline recovery, then Entryway hot authority; pending registrations keep their selected keys. Public references do not prove private-key custody or recovery readiness.
- PLC confirmation mail is durable; consuming confirmation and authorizing signing are atomic. A lost public signing response requires fresh confirmation. Managed handle changes and moves save signed operations before sending and reuse them after interruption. Directory refresh preserves custody history without granting access or clearing uncertain writes; signing alone does not prove publication.
- Acknowledged registrations can activate during classified transient directory outages, keeping `custody:refresh-pending` until observation succeeds. Invalid evidence, custody conflicts and lost ownership still block activation.
- Registration and hosted-handle changes share configured-domain, single-label and 3–18-character limits.
- **Requires a fresh database; no existing-database upgrade.** Full public migration and disaster recovery remain unqualified; repository signing keys remain PDS-owned.
