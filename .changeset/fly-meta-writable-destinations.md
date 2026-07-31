---
'nanoclaw-sessionio': patch
---

Apply HTTP `/meta` destinations with a writable inbound.db handle on Fly guests (read-only `getInboundDb` writes were failing silently and leaving `unknown:` reply drops).
