---
"hypercerts-entryway": minor
---

Configure authenticated implicit TLS SMTP using `MAIL_SMTP_MODE=tls`, `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_USER`, `MAIL_SMTP_PASSWORD`, and `MAIL_FROM`. Private capture defaults remain available; set `MAIL_SMTP_MODE=private` explicitly for a different private relay. See the [deployment guide](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/deployment-profiles.md#smtp-delivery-configuration) for certificate trust and secret rotation.

Administrator `sendEmail` reports `sent: true` only when SMTP relay acceptance is confirmed.
