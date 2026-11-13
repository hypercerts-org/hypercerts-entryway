---
"hypercerts-entryway": patch
---

- PostgreSQL: a backend that dies while its connection is checked out no longer raises an unhandled `error` event, and connections that received a FATAL reply are discarded instead of returned to the pool.
