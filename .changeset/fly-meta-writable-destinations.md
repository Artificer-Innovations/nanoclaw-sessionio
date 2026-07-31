---
'nanoclaw-sessionio': patch
---

Apply HTTP `/meta` destinations with a writable inbound.db handle on Fly guests, using bun:sqlite `$named` binds (read-only `getInboundDb` and better-sqlite3-style `@name` keys were leaving NULL/empty destinations and `unknown:` reply drops).
