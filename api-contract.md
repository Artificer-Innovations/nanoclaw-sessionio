# API Contract — nanoclaw-sessionio

Normative contract for `nanoclaw-sessionio` API version **1**.

This package installs a pluggable **host↔agent mailbox** (`SessionTransport`) into a NanoClaw fork. The default `filesystem` transport preserves stock SQLite + inbox/outbox semantics. `http` / `loopback` keep the host as the source of truth for queues.

## Capability probe

```ts
getSessionioCapabilities(): {
  apiVersion: 1;
  features: {
    registerSessionTransport: true;
    resolveSessionTransport: true;
    filesystem: boolean;
    http: boolean;
  };
  counts: { transports: number };
  defaultTransport: string;
  transports: string[];
};

probeSessionioCapabilities(load):
  | { present: true; apiVersion; features; counts }
  | { present: false; reason: 'absent'; error? };
```

## Registration model

- `registerSessionTransport(name, transport)` appends/overrides by normalized name; returns unregister.
- `loopback` normalizes to `http` for resolve.
- Resolve order: `session.transportName` → optional resolver → `SESSIONIO_TRANSPORT` → default (`filesystem`).

## SessionTransport

```ts
interface SessionTransport {
  enqueueInbound(session, message): Promise<void> | void;
  pollOutbound(session): Promise<OutboundMessage[]> | OutboundMessage[];
  ackDelivered(session, messageIds, platformMessageIds?): Promise<void> | void;
  getProcessingAcks(session): Promise<ProcessingAck[]> | ProcessingAck[];
  getLiveness(session): Promise<Liveness> | Liveness; // lastHeartbeatAt
  stageInbox(session, messageId, files): Promise<void> | void;
  consumeOutbox(session, messageId): Promise<Attachment[]> | Attachment[];
  syncSessionMeta?(session, meta): Promise<void> | void;
}
```

Wire fields mirror `messages_in` / `messages_out` (incl. seq expectations at the agent UX layer).

## HTTP peer protocol (host source of truth)

Base URL from `SESSIONIO_BASE_URL`. Optional `Authorization: Bearer $SESSIONIO_HTTP_TOKEN`.

| Method   | Path                     | Role                                      |
| -------- | ------------------------ | ----------------------------------------- |
| GET      | `/health`                | Liveness                                  |
| POST/GET | `/inbound`               | Enqueue / agent poll+take                 |
| POST/GET | `/outbound`              | Agent post / host poll                    |
| POST     | `/outbound/ack`          | Host ack delivered                        |
| POST/GET | `/acks`                  | Processing acks                           |
| POST/GET | `/heartbeat` `/liveness` | Agent heartbeat / host liveness           |
| POST/GET | `/inbox` `/outbox`       | Attachment blobs (JSON base64)            |
| POST/GET | `/meta`                  | Session routing / destinations projection |

Query: `agentGroupId`, `sessionId`.

## Illegal pairing

`filesystem` transport with remote runtimes (e.g. Fly) is **invalid**. Consumers (`nanoclaw-agenthosts` / flyio) must reject that pair.

## Installer contract

- Atomic stage → rename writes with rollback
- Idempotent `@nanoclaw-sessionio:*` markers
- `verify` fails closed if anchors moved
- `uninstall` restores markers / stock drainSession and removes copied modules
