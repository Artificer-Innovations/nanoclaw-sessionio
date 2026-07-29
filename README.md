# nanoclaw-sessionio

Pluggable **host↔agent mailbox** for NanoClaw. Stock NanoClaw assumes the host and agent share a local filesystem (SQLite session DBs, inbox/outbox mounts). This package keeps the same message semantics while making that assumption optional.

**Why it exists:** so the NanoClaw **host** and the **agent runner** do not have to live on the same machine—or even share a disk.

With the HTTP mailbox transport, the host owns the queues and exposes them over the network; the agent dials in. That unlocks setups like:

- Host on a workstation or always-on box; agents on a separate server, VM, or container host
- Multiple agent machines talking to one host mailbox
- Agents behind a different network namespace (remote Docker/Kubernetes, LAN boxes, a cloud VM) where bind-mounting `data/v2-sessions` is impossible or undesirable
- Local development that mirrors remote topology (HTTP over `host.docker.internal` / loopback) before you deploy split host/agent

Default install stays on the **filesystem** transport (zero behavior change). Switch to **http** when the agent cannot see the host’s session directories.

| Transport | Role |
| --- | --- |
| **filesystem** (default) | Shared session dirs / SQLite — same machine, mounts available |
| **http** | Host HTTP mailbox; agent peers over HTTP — no shared mounts |
| **loopback** | Alias for **http** (same protocol). Handy name for local Docker→host tests |

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
