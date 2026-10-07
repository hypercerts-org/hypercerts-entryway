# Keep uncertain external writes pending

A database lease can reject a stale worker's local write, but cannot cancel an
unchanged PDS request already sent or paused before dispatch. Observing the desired
remote state does not prove that an older request cannot apply later.

Entryway retains the exact operation, attempt and target, blocking conflicting
account changes until definitive reconciliation is possible. Operator recovery
requires evidence that the old dispatcher cannot resume and upstream work has
finished or been drained. A fresh fenced execution then makes an operation-specific
observation. Audit references are trusted operator attestations, not machine proof;
lease expiry and a matching status alone never clear admission.

This favors authority consistency over automatic recovery for the affected account;
unrelated accounts can continue. A safely repeatable action is recorded as such,
not declared unapplied. Unsupported or divergent outcomes remain pending. Only
narrowly audited, fully consumed pre-publication PLC rejections have a terminal
negative path; generic upstream errors do not. SMTP uncertainty can still cause
duplicate delivery.

The [shared-operation guide](../shared-operations.md) defines exact recovery bindings,
authorization upgrades, observations and exceptions. These rules do not establish
independent-tool migration or complete production recovery.
