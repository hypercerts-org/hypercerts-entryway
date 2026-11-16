---
"hypercerts-entryway": patch
---

Browser clients that call Entryway's XRPC routes directly, such as web migration
tools, need CORS headers that Entryway does not send. Put a reverse proxy in
front of Entryway that adds them to `/xrpc/*` only, as a stock PDS does; leave
`/oauth/*` and the account pages unchanged. See the reference Caddy configuration
in the [deployment guide](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/deployment-profiles.md#browser-access-to-xrpc).
