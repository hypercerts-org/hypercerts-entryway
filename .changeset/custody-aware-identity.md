---
"hypercerts-entryway": minor
---

- Configure a supported public-only `plcRecoveryKeyDid`, distinct from the hot key. New accounts order optional user recovery, operator offline recovery, then Entryway hot authority; pending registrations retain their selected keys. Repository signing stays PDS-owned. Public references do not prove independent private custody or recovery readiness.
- PLC confirmation uses durable mail delivery. Confirmation consumption and signature-release authorization commit atomically; ordinary wrong-code accounting remains. A lost public signing response requires fresh confirmation. Signing history is not publication or effective directory authority.
- Internal handle changes and managed moves/repairs atomically save exact signed operations before dispatch, resuming them without re-signing. Fenced directory observations retain supporting evidence and distinguish publication from directory-asserted nullification, preserve attributed custody, retire removed PLC/repository keys and leave OAuth issuer lifecycle independent. Refresh never clears uncertain writes or grants account access.
- Successful PDS registration may activate only through the existing fallback for classified directory-evidence outages, retaining `custody:refresh-pending` without fabricating authority. Reconciliation clears the marker with a successful observation; invalid evidence, custody contradictions and lost ownership still block activation.
- Registration and hosted-handle changes share the configured-domain, single-label restriction and 3–18-character label bounds.
- **Fresh database state is required; no existing-database upgrade is provided.** Complete public migration and disaster-recovery qualification remain separate release requirements.
