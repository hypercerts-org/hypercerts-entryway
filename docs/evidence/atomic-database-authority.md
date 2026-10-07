# Keep account authority in one transaction

Email claims, DID bindings, browser proof and revocation must agree after either
success or failure. Splitting an account change into sequential provider API calls
would leave authority partly changed when a later call fails.

Entryway therefore gives its own account operations and Better Auth's public
Drizzle adapter the same physical database transaction. SQLite gates every access
to its connection, including readers and provider calls; PostgreSQL pins a client
and serializes multi-statement authority writes with an advisory lock. Nested
operations reuse that transaction. SMTP and upstream HTTP stay outside it.

The tradeoff is deliberately serialized authority writes rather than maximum
write concurrency. This keeps rollback and asynchronous callers consistent across
both dialects without modifying the provider. SQLite is supported on one node;
multiple nodes require PostgreSQL. Fresh schema initialization does not implement
old-state upgrades or satisfy public account-migration requirements.

The [database guide](../database.md) owns configuration and transaction details;
[identity custody](../data-custody.md) owns the account and provider boundaries.
