---
"nanoclaw-sessionio": patch
---

Fix Fly/HTTP `send_file` from MCP child processes: gate the sync outbound bridge on `isRemotePeerMode()` (MCP children never register a peer), stage `/outbox` attachments before posting `/outbound`, and add `buildOutboxSyncCurlArgs` so curl can stage without `getSessionioPeer()`.
