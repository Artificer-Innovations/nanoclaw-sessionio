# API Contract — nanoclaw-sessionio

Normative contract for `nanoclaw-sessionio` API version **1**.

This package installs a pluggable **host↔agent mailbox** (`SessionTransport`) into a NanoClaw fork. The default `filesystem` transport preserves stock SQLite + inbox/outbox semantics. `http` / `loopback` keep the **host process** as the runtime source of truth for queues (an in-memory store — see Durability below).

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

### HTTP inbound scheduling parity

`HostMailboxStore.takeInbound` applies the same `processAfter` / `onWake` / `limit` filters as the stock DB poll path. Wire rows projected into the agent may still hardcode `tries: 0` / `seq: null` where the peer bridge does not round-trip those columns — treat scheduled/recurring/onWake behavior as best-effort parity in 0.1.0 and prefer conformance tests in forks that care.

## Durability (http / loopback)

`http` / `loopback` use an **in-process** `HostMailboxStore` (`Map`s in the host Node process) — not SQLite.

**What happens when the host restarts mid-queue?** Every pending inbound/outbound message, delivery state, processing ack, staged inbox/outbox attachment, and session meta for the HTTP transport is **dropped**. Agents and upstream platforms must re-enqueue or rely on their own redelivery. This is an intentional 0.1.0 limitation of the HTTP mailbox (fine for trusted loopback / solo hosts). Filesystem transport retains SQLite durability across host restarts.

E2E note: a test plan step of “restart host, send a webchat message” is safe **after** the restart (empty queues). It must not assume messages that were already queued before the restart still exist.

Outbound delivery uses splice-on-ack; idle session maps are swept by last-activity age so a long-lived host does not retain unbounded per-session memory.

## HTTP peer protocol (host source of truth)

Base URL from `SESSIONIO_BASE_URL`. Optional `Authorization: Bearer $SESSIONIO_HTTP_TOKEN`.

The shared bearer is **not a tenant boundary** — any holder can address any `agentGroupId`/`sessionId`. Isolation belongs to the per-tenant host process (e.g. Fly plan), not this layer. Prefer setting a token whenever the listen address is non-loopback; unset token + non-loopback bind logs a one-shot warning.

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

Request bodies are capped (default 10 MiB). Peer clients use per-attempt timeouts with a small jittered retry on network / 5xx failures. Sync curl outbound uses `--connect-timeout` / `--max-time`.

## Illegal pairing

`filesystem` transport with remote runtimes (e.g. Fly) is **invalid**. Consumers (`nanoclaw-agenthosts` / flyio) must reject that pair.

## Installer contract

- Atomic stage → rename writes with rollback
- Idempotent `@nanoclaw-sessionio:*` markers
- `verify` fails closed if anchors moved
- `uninstall` restores markers / stock drainSession and removes copied modules
