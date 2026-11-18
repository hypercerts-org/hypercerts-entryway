---
"hypercerts-entryway": minor
---

For maintainers assembling the still-dormant incoming flow, this adds the code that turns a prepared arrival into a
provisioned, still-pending destination. It accepts the source-signed authority
handoff, which claims the DID, then reserves the destination repository key and
creates the destination account ahead of data transfer. Nothing here is reachable yet: no route is
mounted, so an operator sees no behaviour change until the public API is
assembled.

Dormant preparation now checks the destination browser session, origin/CSRF and
fresh OTP before saving an unclaimed preparation that holds nothing. It validates the configured
PLC history and retains the exact signed predecessor and CID, including legacy
`create` identities. Existing rotation priority is preserved; the Entryway hot key
is added only within the protocol limit. This remains preparation evidence, not
source ownership or activation readiness.

Dormant authenticated admission now verifies the source repository JWT's document
identity, controller, method, audience and replay identity, with a maximum
300-second lifetime. Handoff admission and signed public bytes commit together
before directory dispatch. The claim, replay binding, signed handoff and pending
checkpoint commit together after the source credential verifies. Lost responses retain the existing isolation/drain
recovery requirement; saved-owner continuation reuses accepted bytes without a
new source credential after key cutover. Creation admission reuses registration's
real invitation producer atomically, without copying raw invite codes into incoming
journals. Supported creation fields are handle and optional DID, email and invite;
other stock optional fields are explicitly rejected. Dormant creation continuation
now uses the saved owner and admission without a new source JWT or arrival code.
It journals the exact destination move, observes and pauses the backend using
configured administrator credentials, and atomically binds the pending account
with invitation completion. Lost creation or pause responses still require
verified isolation/drain recovery. A published move without a backend stays
pending without blind creation or fresh key reservation. Public migration
qualification remains separate work.

Dormant saved-user lifecycle: renewal issues a replacement code after a fresh
destination OTP, and cancellation deletes an unclaimed preparation without
touching the DID. A claimed arrival is never cancelled and keeps its recorded
admissions across renewal. Renewal stays available between provisioning and
binding, where replaying the already accepted `createAccount` with the new code
needs no source credential and resumes the saved provisioning.
Admission requires the current, unexpired code and refuses a stale one with
`ArrivalExpired`.

What this will mean once it is wired:

- The destination PDS is asked for a public repository key without any Entryway
  credential. Only the public key is stored; the private key stays on that PDS.
  Early cutover, separate deactivation and retained recovery obligations are what
  this flow claims — it is **not** an independent interoperability claim.
- The repository key is reserved only after the handoff is canonical and the DID
  is claimed. A lost reservation response keeps the arrival pending for operator
  recovery rather than silently reserving elsewhere.
- The source-signed handoff is checked against the expected predecessor, the
  approved key order and the unchanged source service, verification key and
  aliases. A full key list is rejected rather than truncated, and removing or
  reordering keys is refused. The accepted operation is stored before it is sent
  directly to the configured PLC directory, and publication is only claimed once
  canonical history shows it.
- Destination creation requires a fresh source credential scoped to account
  creation; a handoff-scoped credential cannot authorize it. Account creation
  publishes Entryway's destination move, so the account is briefly active before
  it is deactivated. The two steps stay distinct, and the result is a pending
  arrival rather than a usable account. A creation or pause that certainly did not
  take effect can be resent after operator approval.
- Every unresolved step — an unobserved handoff, a creation whose response was
  lost, a deactivation that did not take effect — keeps the arrival pending with
  a stable recovery code. None of these are repaired by signing a different
  identity operation.

Until the remaining readiness work lands, no transfer credentials are issued and
no arrival becomes active.
