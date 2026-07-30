# Removing nanoclaw-sessionio

## Order

1. Uninstall **dependents first** (anything that registers transports or assumes sessionio markers), e.g. `nanoclaw-agenthost-flyio`.
2. Then:

```bash
pnpm exec nanoclaw-sessionio uninstall
pnpm remove nanoclaw-sessionio
pnpm run build
./container/build.sh
# restart host
```

## What uninstall removes

- `@nanoclaw-sessionio:*` marker blocks in session-manager, delivery (`delivery-import`, `delivery-drain`, `delivery-outbox`), host-sweep, container-runner, index, runner index, mcp-tools (`mcp-register`), poll-loop, messages-out
- Unmarked legacy `consumeOutbox` attachment blocks in `src/delivery.ts` (scavenged back to stock `readOutboxFiles`)
- Unmarked MCP `registerSessionioRunner` boots and bare `sessionioWriteMessageOut` poll-loop leftovers
- Copied modules under `src/sessionio*.ts`, `src/warn-once-sessionio.ts`, runner `sessionio/`
- `.claude/skills/add-sessionio/`

## Leave alone

- Unrelated packages (`nanoclaw-hosthooks`, `nanoclaw-agenttrace`, `nanoclaw-webchat`) and their markers
- Central `data/v2.db` and existing session folders (data is not deleted)
