# Contributing

## Develop

```bash
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run test:unit
pnpm run test:coverage
pnpm run build
```

## Layout

| Path                   | Role                                                       |
| ---------------------- | ---------------------------------------------------------- |
| `packages/shared`      | Shared types + warnOnce                                    |
| `packages/host`        | Registry, transports, HTTP server, boot (copied into fork) |
| `packages/runner`      | Agent HTTP peer (copied into container runner)             |
| `packages/cli`         | Installer CLI                                              |
| `skills/add-sessionio` | Bundled skill + resources                                  |

Use changesets for user-facing changes. Branch flow: `develop` → `main` release.
