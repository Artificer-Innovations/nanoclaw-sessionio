# Changelog

## 0.1.1

### Patch Changes

- [#7](https://github.com/Artificer-Innovations/nanoclaw-sessionio/pull/7) [`fc402bf`](https://github.com/Artificer-Innovations/nanoclaw-sessionio/commit/fc402bff6f61a5fe8adebf99d21ac08d47e6569a) Thanks [@ZappoMan](https://github.com/ZappoMan)! - Anchor delivery uninstall drain restore on the typed deliverMessage, not an early stub.

- [#7](https://github.com/Artificer-Innovations/nanoclaw-sessionio/pull/7) [`fc402bf`](https://github.com/Artificer-Innovations/nanoclaw-sessionio/commit/fc402bff6f61a5fe8adebf99d21ac08d47e6569a) Thanks [@ZappoMan](https://github.com/ZappoMan)! - Fix Fly/HTTP `send_file` from MCP child processes: gate the sync outbound bridge on `isRemotePeerMode()` (MCP children never register a peer), stage `/outbox` attachments before posting `/outbound`, pipe curl JSON bodies via stdin (`--data-binary @-` + `TextEncoder`) to avoid ARG_MAX/silent drops on large attachments, and strip legacy unmarked `postOutboundSync` bridges before reinject so upgrades cannot duplicate the helper. Also promote host `deliverMessage` outbox consumption to a marked `delivery-outbox` patch (install + uninstall) and scavenge unmarked `consumeOutbox` hotfixes so uninstall cannot leave a broken `resolveSessionTransport` call site. Mark MCP `registerSessionioRunner` in `mcp-tools/index.ts`, and scavenge bare `sessionioWriteMessageOut` poll-loop leftovers (not only `await` forms) on uninstall.

- [#7](https://github.com/Artificer-Innovations/nanoclaw-sessionio/pull/7) [`fc402bf`](https://github.com/Artificer-Innovations/nanoclaw-sessionio/commit/fc402bff6f61a5fe8adebf99d21ac08d47e6569a) Thanks [@ZappoMan](https://github.com/ZappoMan)! - Make uninstall restore `host-sweep` `heartbeatMtimeMs` in place (not at EOF), remove empty `container/agent-runner/src/sessionio/` dirs, and collapse leftover blank lines before `writeMessageOut`.

## 0.1.0

- Initial release: SessionTransport registry, filesystem default, HTTP/loopback transport, CLI installer + skill.
