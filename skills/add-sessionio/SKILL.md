---
name: add-sessionio
description: Install pluggable host↔agent session mailbox transports (filesystem default + HTTP/loopback) into a NanoClaw fork.
---

# Add sessionio

Installs `nanoclaw-sessionio`: a **SessionTransport** registry so mailbox IO is no longer hard-coded to shared SQLite + inbox/outbox mounts.

## When you need this

- Default install keeps **filesystem** transport — identical to today’s `data/v2-sessions/...` behavior.
- Use **http** / **loopback** when the agent cannot share the host filesystem (remote Machines, multi-host tests).

## Install

```bash
pnpm add nanoclaw-sessionio
pnpm exec nanoclaw-sessionio sync-skill
pnpm exec nanoclaw-sessionio install
pnpm install
pnpm run build
./container/build.sh
pnpm exec nanoclaw-sessionio verify
```

In **nanoclaw-sandbox** (local package loop):

```bash
pnpm sessionio:local
./container/build.sh
pnpm exec nanoclaw-sessionio verify
```

## Illegal pairing note

**filesystem + remote runtime (e.g. Fly) is illegal** — there is no shared mount. Remote agenthosts must use the **http** transport. Co-located runtimes (docker / process / Apple Container) may keep filesystem.

## Conformance

After install, `src/sessionio.conformance.test.ts` asserts heartbeat liveness helpers and HTTP store ack semantics. Run host tests to pick it up.

## Env

| Key                                           | Purpose                                       |
| --------------------------------------------- | --------------------------------------------- |
| `SESSIONIO_TRANSPORT`                         | `filesystem` (default), `http`, or `loopback` |
| `SESSIONIO_HTTP_HOST` / `SESSIONIO_HTTP_PORT` | Host mailbox bind                             |
| `SESSIONIO_BASE_URL`                          | Agent peer URL                                |
| `SESSIONIO_HTTP_TOKEN`                        | Optional bearer token                         |

See [REMOVE.md](./REMOVE.md) before uninstalling if dependents (e.g. `nanoclaw-agenthost-flyio`) are installed.
