# Implementation assessment

Entryway has three implemented foundations:

- [Database authority](database.md): asynchronous Drizzle operations, fresh SQLite
  and PostgreSQL schemas, and a shared physical transaction for account claims,
  Better Auth identity and revocation. Single-node deployments accept either
  backend; multiple nodes require PostgreSQL.
- [Shared operations](shared-operations.md): durable admissions, execution fences,
  mail claims and operator-verified recovery. Uncertain external work retains
  admission until old-dispatch isolation, upstream completion and operation-specific
  observation establish a safe continuation.
- [Deployment lifecycle](deployment-profiles.md): database-aware readiness,
  bounded request/worker shutdown and one- and two-process profile checks behind
  one issuer. Request balancing does not replicate PDS data.

The [testing guide](testing.md) describes repeatable regression gates. A passing
managed scenario establishes its tested behavior, not every release requirement
or production configuration. The domain guides above explain the design tradeoffs;
delivery priorities and approvals belong in the
[project document](https://linear.app/hypercerts/document/m1-acceptance-matrices-epds-parity-protocol-and-migration-196f21e01e71).

## Known limits

- **Operator onboarding:** the approved order is operator-supplied PDS
  configuration, PDS apply/restart, live identity/issuer/callback verification,
  then effective association. Static host configuration is implemented; the
  onboarding CLI/registry workflow is not. Existing-PDS conversion qualification
  and operator runbooks remain later work. Separate organizations may operate
  isolated Entryways; inter-Entryway federation and an email-discovery router are
  not requirements. Public protocol and migration compatibility remain required.
- **Shared-authority outages:** replicas retain one issuer. A full Entryway or
  authority-database outage disrupts login, refresh, signup and delegated account
  operations. Already-issued tokens permit only the PDS-local operations that
  still pass required checks before expiry. The managed deployment profiles do
  not establish blanket PDS availability or exhaustive endpoint outage coverage.

- **Multiple accounts per email:** accounts can share an email after migration or
  import. One verified login can access multiple accounts, but access must be
  granted separately for each account—matching emails alone are not enough.

  Email changes, backup recovery, and admin repairs cannot move an account to an
  email already used by another account. Moving one account to an unused email
  leaves the others unchanged.

  Migration can link the imported account to a login without granting access to
  other accounts that share its email.

  After OTP verification, a login bound to several accounts sees an account
  chooser; submission re-reads current bindings and continues only with the
  explicit choice. Importing account-to-login links from a joining PDS is not
  implemented yet. Email-level session revocation remains conservative for a
  shared user, while OAuth/account data stays DID-scoped. See
  [account identity](data-custody.md#1-account-identity-and-ownership).

- **Moderation:** raw interoperability still exits 2 with
  `MISSING_REQUIRED_MODERATION_COORDINATION`. The wrapper recognizes this specific
  inherited failure; it does not turn it into a product pass.
- **Credential lifetime:** `src/pds/access-token.ts` and the equivalent managed
  migration signer in `src/features/pds-migration/move-between-pds.mjs` call
  `.setIssuedAt()` and `.setExpirationTime("60s")` separately. Crossing a second
  boundary can produce `exp - iat = 61`, violating the strict 60-second bound.
  This observed defect remains unfixed. Both claims need one time sample; later
  passing tests do not resolve it.
- **Migration and custody:** the external helper uses private synthetic APIs and
  assumed keys. Public-protocol migration with normal credentials, whole-PDS
  joining and repeatable transfer history remain unimplemented requirements;
  selecting a tool/version is not a gate. Standard PLC authorization permits
  individual migration with different source/destination emails; destination
  email proof only establishes login binding. The approved hot/offline/optional
  user key roles and normal departure rules still need their operational
  implementation. An operator offline key alone cannot guarantee exit from a
  refusing operator, and PLC control does not restore unavailable data. See
  [custody and migration](data-custody.md#4-custody-boundaries). Fresh schema
  initialization provides no old-state upgrade path and does not replace these
  product journeys.
- **Product coverage:** complete ePDS consent/freshness parity, XRPC integration,
  production email coverage and fleet eligibility/placement/drain/retirement remain
  separate work. Preserved MJS is outside strict TypeScript coverage.
- **Production operations:** managed local checks do not establish full disaster
  recovery, throughput, zero-downtime key overlap, every deployment's restore/key
  qualification or exhaustive fault/abuse behavior. Operator recovery attestations
  are trusted assertions, not machine proof. SMTP uncertainty can duplicate mail.

Existing password/app-password APIs and email proofs remain active protocol
behavior; removing obsolete data-conversion machinery does not remove them.
Reference PDS and provider implementations remain unchanged.
