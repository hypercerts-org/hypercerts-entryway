---
"hypercerts-entryway": minor
---

Require the public-only `plcRecoveryKeyDid` operator recovery reference. New accounts place optional user recovery first, operator recovery second and the Entryway hot key last, with repository signing remaining PDS-owned. Pending registrations retain their selected public rotation keys across deployment-default changes. Configure a supported public did:key distinct from the hot key before starting the service; a public reference alone does not establish independent private custody or recovery readiness.

Commit PLC signature-release authorization and confirmation consumption together, while retaining ordinary wrong-code attempt accounting. A lost response after authorization requires a new confirmation. Authorized signing history does not establish publication or effective directory authority. Fenced audit observations record last-observed authority separately, trusting the configured directory for historic branch selection and nullification while validating surviving signatures and CIDs. Internal custody refresh never clears uncertain writes or grants account access. The new database tables require fresh state; this change provides no existing-database upgrade, complete public migration or disaster-recovery qualification.

PLC operation confirmations use the existing durable mail delivery queue and SMTP
transport. Other legacy XRPC mail flows are unchanged. Public observation history
retains explicit supporting observation IDs and directory provenance after later
snapshots replace the observed head. Publication and directory-asserted nullification
have distinct provenance; forged observation kinds or missing evidence are rejected.
Internal handle changes and managed moves/repairs atomically retain exact signed
operations with custody history before dispatch, so interrupted return resumes the
saved operation without re-signing or another confirmation.

Directory observations retire removed PLC rotation and repository keys while
preserving their attributed roles and provenance. Replacement repository keys
remain visible by public reference; OAuth issuer lifecycle is independent.

A successful PDS registration can activate while directory evidence is temporarily
unavailable. The database retains an explicit `custody:refresh-pending` error;
no observed authority snapshot is fabricated. A successful privileged custody
refresh clears that marker atomically with the observation. Invalid evidence,
custody contradictions and lost operation ownership still block activation.
