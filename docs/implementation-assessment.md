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

- **Moderation:** raw interoperability still exits 2 with
  `MISSING_REQUIRED_MODERATION_COORDINATION`. The wrapper recognizes this specific
  inherited failure; it does not turn it into a product pass.
- **Credential lifetime:** `src/pds/access-token.ts` and the equivalent managed
  migration signer in `src/features/pds-migration/move-between-pds.mjs` call
  `.setIssuedAt()` and `.setExpirationTime("60s")` separately. Crossing a second
  boundary can produce `exp - iat = 61`, violating the strict 60-second bound.
  This observed defect remains unfixed. Both claims need one time sample; later
  passing tests do not resolve it.
- **Migration and custody:** the external migration helper uses private synthetic
  APIs and assumed keys. Independent migration with unchanged tools and normal
  credentials, existing ePDS conversion, repeatable transfer history and general
  recovery custody remain required. Fresh schema initialization provides no
  old-state upgrade path and does not replace those journeys.
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
