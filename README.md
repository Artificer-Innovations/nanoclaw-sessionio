# nanoclaw-sessionio

Pluggable **host↔agent mailbox** for NanoClaw. Replaces the hard-coded assumption that session IO is shared local SQLite + filesystem inbox/outbox, while keeping message semantics intact.

- **Default:** `filesystem` — zero behavior change
- **Optional:** `http` / `loopback` — host is source of truth; agent speaks HTTP (needed for remote agents / Fly)

Delivery model matches `nanoclaw-hosthooks`: npm package + skill installer that patches your NanoClaw fork. Not an upstream core PR.

## Quick start

```bash
pnpm add nanoclaw-sessionio
pnpm exec nanoclaw-sessionio install
pnpm run build && ./container/build.sh
pnpm exec nanoclaw-sessionio verify
```

See [QUICKSTART.md](./QUICKSTART.md) and [api-contract.md](./api-contract.md).

## Develop against nanoclaw-sandbox

```bash
# from nanoclaw-sandbox
pnpm sessionio:local
./container/build.sh
pnpm exec nanoclaw-sessionio verify
```

## License

MIT © Artificer Innovations, LLC
