---
"hypercerts-entryway": minor
---

Entryway now delivers signup codes and account security tokens through the configured mail relay. It supports authenticated SMTP over TLS and a configurable sender. `com.atproto.admin.sendEmail` returns `sent: true` only after the relay accepts the message. [SMTP settings](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/deployment-profiles.md#smtp-delivery-configuration)
