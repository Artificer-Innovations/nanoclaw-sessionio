# nanoclaw-sessionio

Pluggable **host↔agent mailbox** for NanoClaw. Replaces the hard-coded assumption that session IO is shared local SQLite + filesystem inbox/outbox, while keeping message semantics intact.

| Transport | Role |
| --- | --- |
| **filesystem** (default) | Zero behavior change — shared session dirs / SQLite |
| **http** | Host HTTP mailbox; agent peers over HTTP (remote agents, no shared mounts) |
| **loopback** | Alias for **http** (same protocol/store). Convenient name for local Docker→host tests |

Delivery model matches `nanoclaw-hosthooks`: npm package + skill installer that patches your NanoClaw fork. Not an upstream core PR.

## Quick start

```bash
pnpm add nanoclaw-sessionio
pnpm exec nanoclaw-sessionio install
pnpm run build && ./container/build.sh
pnpm exec nanoclaw-sessionio verify
# restart NanoClaw host
```

**Docs:** [QUICKSTART.md](./QUICKSTART.md) (env vars, transport choice, local vs multi-host) · [api-contract.md](./api-contract.md)

### Minimal HTTP / loopback `.env`

```bash
SESSIONIO_TRANSPORT=loopback          # or http — same wire protocol
SESSIONIO_HTTP_HOST=0.0.0.0           # listen (reachable from Docker)
SESSIONIO_HTTP_PORT=18765
SESSIONIO_BASE_URL=http://host.docker.internal:18765   # dial URL from the agent
SESSIONIO_HTTP_TOKEN=<shared-secret>
```

For agents on **another machine**, use `SESSIONIO_TRANSPORT=http` and set `SESSIONIO_BASE_URL` to a host URL that machine can reach (not `host.docker.internal` unless that name resolves there). Details in [QUICKSTART.md](./QUICKSTART.md).

## Develop against nanoclaw-sandbox

```bash
# from nanoclaw-sandbox
pnpm sessionio:local
pnpm run build
# restart host (runner source is bind-mounted; image rebuild usually optional)
pnpm exec nanoclaw-sessionio verify
```

## License

MIT © Artificer Innovations, LLC
