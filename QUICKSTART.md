# Quick start — nanoclaw-sessionio

## Install into a NanoClaw fork

```bash
pnpm add nanoclaw-sessionio
pnpm exec nanoclaw-sessionio sync-skill
pnpm exec nanoclaw-sessionio install
pnpm install
pnpm run build
./container/build.sh   # only needed if your image bakes runner source; sandbox bind-mounts it
pnpm exec nanoclaw-sessionio verify
```

Then restart the NanoClaw host so boot loads sessionio and (for HTTP) the mailbox server.

Default transport is **filesystem** — same shared SQLite + inbox/outbox paths under `data/v2-sessions/...` as stock NanoClaw.

## Transports: filesystem vs http vs loopback

| `SESSIONIO_TRANSPORT`  | What it does                                      | When to use                                                       |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| `filesystem` (default) | Host and agent share session dirs / SQLite        | Co-located agents (local Docker with mounts)                      |
| `http`                 | Host owns an HTTP mailbox; agent peers over HTTP  | Remote agents, or any setup without shared mounts                 |
| `loopback`             | **Alias for `http`** (normalized at resolve time) | Same as `http`, named for “HTTP on this host” / Docker→host tests |

**`loopback` is not a different protocol.** It registers and resolves to the same HTTP transport and in-memory host store. Prefer the name `http` when the agent is on another machine; use `loopback` if you want the env to read as “local HTTP mailbox” (e.g. sandbox + `host.docker.internal`).

**Different physical machines:** set `SESSIONIO_TRANSPORT=http` (or `loopback` — same wire). Bind the mailbox on an interface the agent can reach, set `SESSIONIO_BASE_URL` to that reachable URL (host IP / DNS / tunnel — **not** `host.docker.internal` unless that name resolves on the agent), and use the same `SESSIONIO_HTTP_TOKEN` on both sides.

**Illegal pairing:** `filesystem` + remote runtime (e.g. Fly) — no shared mount. Remote agents must use `http` / `loopback`.

## Environment variables

NanoClaw does **not** load `.env` into `process.env` for arbitrary keys. Sessionio boot reads these from `.env` when unset. The installer also injects the peer-side vars into `docker run -e` when transport is HTTP.

### Core

| Variable              | Required                  | Meaning                                       |
| --------------------- | ------------------------- | --------------------------------------------- |
| `SESSIONIO_TRANSPORT` | No (default `filesystem`) | `filesystem` \| `http` \| `loopback` (→ http) |

### Host mailbox server (only when transport is `http` / `loopback`)

| Variable               | Required               | Meaning                                                                                                                                                      |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SESSIONIO_HTTP_HOST`  | No (default `0.0.0.0`) | Bind address for the mailbox HTTP server. Use `0.0.0.0` so Docker agents can reach the host; `127.0.0.1` is host-only and usually breaks container peers.    |
| `SESSIONIO_HTTP_PORT`  | No (default `18765`)   | Bind port                                                                                                                                                    |
| `SESSIONIO_HTTP_TOKEN` | Recommended            | Shared bearer secret. If set, every request must send `Authorization: Bearer <token>`. Use the **same** value on host and agent. Empty = no auth (dev only). |

### Agent peer (HTTP / loopback)

These must be visible inside the agent process. The installer injects them on container spawn when transport resolves to `http`; for non-Docker agents, set them in that runtime’s env.

| Variable                   | Required for HTTP              | Meaning                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSIONIO_BASE_URL`       | **Yes**                        | Base URL the **agent** uses to call the host mailbox (no trailing slash required). Examples: `http://host.docker.internal:18765` (Docker Desktop → host), `http://10.0.0.5:18765` (LAN), `https://mailbox.example.com`. |
| `SESSIONIO_TRANSPORT`      | Yes (injected)                 | Must be `http` or `loopback` inside the agent or it keeps using SQLite.                                                                                                                                                 |
| `SESSIONIO_HTTP_TOKEN`     | If host requires it            | Same bearer as the host                                                                                                                                                                                                 |
| `SESSIONIO_SESSION_ID`     | Injected by installer          | Session id for mailbox query params                                                                                                                                                                                     |
| `SESSIONIO_AGENT_GROUP_ID` | Injected (or `container.json`) | Agent group id for mailbox query params                                                                                                                                                                                 |

Also injected when needed: `NO_PROXY` / `no_proxy` including the peer hostname so OneCLI/`HTTP_PROXY` does not swallow mailbox traffic.

### What does _not_ need to match

- `SESSIONIO_HTTP_HOST` is the **listen** address on the host.
- `SESSIONIO_BASE_URL` is the **dial** URL from the agent’s network namespace.
- They often differ (bind `0.0.0.0`, dial `http://host.docker.internal:18765` or a public hostname).

## Local Docker smoke (sandbox / co-located agent)

```bash
# .env on the host
SESSIONIO_TRANSPORT=loopback
SESSIONIO_HTTP_HOST=0.0.0.0
SESSIONIO_HTTP_PORT=18765
SESSIONIO_BASE_URL=http://host.docker.internal:18765
SESSIONIO_HTTP_TOKEN=<long-random-secret>
```

1. `pnpm exec nanoclaw-sessionio install` (or `pnpm sessionio:local` in sandbox)
2. `pnpm run build` and restart the host
3. Confirm log: `Sessionio HTTP mailbox listening bind="0.0.0.0:18765" …`
4. Send a chat; new container should show `SESSIONIO_*` in `docker inspect … Config.Env`
5. Optional: `curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18765/health` → `{"ok":true}`

## Multi-host / remote agent sketch

```bash
# host machine .env
SESSIONIO_TRANSPORT=http
SESSIONIO_HTTP_HOST=0.0.0.0
SESSIONIO_HTTP_PORT=18765
SESSIONIO_HTTP_TOKEN=<shared-secret>
# optional advertise for local tooling; agents use their own BASE_URL
SESSIONIO_BASE_URL=http://127.0.0.1:18765

# agent machine / Fly / remote runtime env
SESSIONIO_TRANSPORT=http
SESSIONIO_BASE_URL=http://<host-reachable-name-or-ip>:18765
SESSIONIO_HTTP_TOKEN=<same-shared-secret>
SESSIONIO_SESSION_ID=<session-id>
SESSIONIO_AGENT_GROUP_ID=<agent-group-id>
```

Open the port (or put a TLS proxy in front). Prefer a real secret for `SESSIONIO_HTTP_TOKEN`. The token is a **shared bearer, not a tenant boundary** — isolation is the per-tenant host process. Today’s HTTP store is **in-memory on the host process** — a host restart clears pending mailbox queues (filesystem transport keeps SQLite durability). See `api-contract.md` § Durability.

## nanoclaw-sandbox peer loop

```bash
pnpm sessionio:local              # file: ../nanoclaw-sessionio
pnpm sessionio:rebuild-local      # after editing the package
pnpm sessionio:published          # npm version
SESSIONIO_VERSION=0.1.0 pnpm sessionio:published
pnpm sessionio:source             # local: … | published: …
```

Override package path: `NANOCLAW_SESSIONIO_DIR=/path/to/nanoclaw-sessionio`.

## Uninstall

See `skills/add-sessionio/REMOVE.md`. Uninstall dependents (e.g. flyio agenthosts) first.
