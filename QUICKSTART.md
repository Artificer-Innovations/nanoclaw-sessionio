# Quick start — nanoclaw-sessionio

## Install into a NanoClaw fork

```bash
pnpm add nanoclaw-sessionio
pnpm exec nanoclaw-sessionio sync-skill
pnpm exec nanoclaw-sessionio install
pnpm install
pnpm run build
./container/build.sh
pnpm exec nanoclaw-sessionio verify
```

Default transport is **filesystem** (unchanged mailbox paths under `data/v2-sessions/...`).

## nanoclaw-sandbox peer loop

Same pattern as webchat / hosthooks:

```bash
pnpm sessionio:local              # file: ../nanoclaw-sessionio
pnpm sessionio:rebuild-local      # after editing the package
pnpm sessionio:published          # npm version
SESSIONIO_VERSION=0.1.0 pnpm sessionio:published
pnpm sessionio:source             # local: … | published: …
```

Override package path: `NANOCLAW_SESSIONIO_DIR=/path/to/nanoclaw-sessionio`.

After local install:

1. `./container/build.sh`
2. Restart the NanoClaw host
3. `pnpm exec nanoclaw-sessionio verify`

## Loopback HTTP smoke

```bash
# in .env
SESSIONIO_TRANSPORT=loopback
SESSIONIO_HTTP_HOST=127.0.0.1
SESSIONIO_HTTP_PORT=18765
SESSIONIO_BASE_URL=http://host.docker.internal:18765
```

Rebuild container, restart host, send a chat message. Mailbox ops go through the host HTTP server (no shared session DB mounts required for queue traffic).

## Uninstall

See `skills/add-sessionio/REMOVE.md`. Uninstall dependents (e.g. flyio) first.
