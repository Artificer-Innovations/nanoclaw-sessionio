---
'nanoclaw-sessionio': patch
---

Fix Fly/HTTP `send_file` from MCP child processes: gate the sync outbound bridge on `isRemotePeerMode()` (MCP children never register a peer), stage `/outbox` attachments before posting `/outbound`, pipe curl JSON bodies via stdin (`--data-binary @-` + `TextEncoder`) to avoid ARG_MAX/silent drops on large attachments, and strip legacy unmarked `postOutboundSync` bridges before reinject so upgrades cannot duplicate the helper. Also promote host `deliverMessage` outbox consumption to a marked `delivery-outbox` patch (install + uninstall) and scavenge unmarked `consumeOutbox` hotfixes so uninstall cannot leave a broken `resolveSessionTransport` call site.
