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

**filesystem + remote runtime (e.g. Fly) is illegal** — there is no shared mount. Remote agenthosts must use the **http** transport (`loopback` is the same wire protocol; it only aliases to `http`). Co-located runtimes (docker / process / Apple Container) may keep filesystem.

## Conformance

After install, `src/sessionio.conformance.test.ts` asserts heartbeat liveness helpers and HTTP store ack semantics. Run host tests to pick it up.

## Env

| Key                                           | Purpose                                                             |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `SESSIONIO_TRANSPORT`                         | `filesystem` (default), `http`, or `loopback` (**alias for http**)  |
| `SESSIONIO_HTTP_HOST` / `SESSIONIO_HTTP_PORT` | Host mailbox **listen** bind (default host `0.0.0.0`, port `18765`) |
| `SESSIONIO_BASE_URL`                          | URL the **agent** dials (often differs from listen host)            |
| `SESSIONIO_HTTP_TOKEN`                        | Optional shared bearer (recommended outside local-only experiments) |

`loopback` is for local/Docker→host wording; multi-machine setups should use `http` with a reachable `SESSIONIO_BASE_URL`. Full tables and examples: package [QUICKSTART.md](../../QUICKSTART.md) (or the copy under your install’s docs).

See [REMOVE.md](./REMOVE.md) before uninstalling if dependents (e.g. `nanoclaw-agenthost-flyio`) are installed.
