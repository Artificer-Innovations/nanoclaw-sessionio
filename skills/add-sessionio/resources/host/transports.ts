import fs from 'node:fs';
import path from 'node:path';
import type {
  Attachment,
  InboundMessage,
  Liveness,
  OutboundMessage,
  ProcessingAck,
  SessionMeta,
  SessionRef,
  SessionTransport,
} from './types.js';

/** Default: drop idle session maps after 1h without activity. */
export const DEFAULT_SESSION_STALE_MS = 60 * 60 * 1000;

/**
 * Host-side in-memory queue store used by the HTTP / loopback transport.
 * Source of truth lives on the host — agents never share SQLite mounts.
 *
 * Durability: process-local only. A host restart clears all maps (see api-contract.md).
 */
export class HostMailboxStore {
  private inbound = new Map<string, InboundMessage[]>();
  private outbound = new Map<string, OutboundMessage[]>();
  private acks = new Map<string, ProcessingAck[]>();
  private heartbeat = new Map<string, number>();
  private inbox = new Map<string, Map<string, Attachment[]>>();
  private outbox = new Map<string, Map<string, Attachment[]>>();
  private meta = new Map<string, SessionMeta>();
  /** Last enqueue/poll/ack/heartbeat/meta touch — used by stale-session sweep. */
  private lastActivity = new Map<string, number>();

  private key(session: SessionRef): string {
    return `${session.agentGroupId}::${session.sessionId}`;
  }

  private touch(k: string, at = Date.now()): void {
    this.lastActivity.set(k, at);
  }

  private deleteKey(k: string): void {
    this.inbound.delete(k);
    this.outbound.delete(k);
    this.acks.delete(k);
    this.heartbeat.delete(k);
    this.inbox.delete(k);
    this.outbox.delete(k);
    this.meta.delete(k);
    this.lastActivity.delete(k);
  }

  enqueueInbound(session: SessionRef, message: InboundMessage): void {
    const k = this.key(session);
    const list = this.inbound.get(k) ?? [];
    list.push({ ...message });
    this.inbound.set(k, list);
    this.touch(k);
  }

  listInbound(session: SessionRef): InboundMessage[] {
    return [...(this.inbound.get(this.key(session)) ?? [])];
  }

  takeInbound(
    session: SessionRef,
    options: { limit?: number; isFirstPoll?: boolean } = {},
  ): InboundMessage[] {
    const k = this.key(session);
    const full = this.inbound.get(k) ?? [];
    const now = Date.now();
    const eligible = full.filter((message) => {
      if (message.processAfter && Date.parse(message.processAfter) > now) return false;
      if (!options.isFirstPoll && (message.onWake ?? 0) === 1) return false;
      return true;
    });
    const limit = options.limit ?? eligible.length;
    const taken = eligible.slice(0, Math.max(0, limit));
    const takenIds = new Set(taken.map((message) => message.id));
    this.inbound.set(
      k,
      full.filter((message) => !takenIds.has(message.id)),
    );
    this.touch(k);
    return taken;
  }

  countDueInbound(session: SessionRef): number {
    const now = Date.now();
    return this.listInbound(session).filter((message) => {
      if (!message.processAfter) return true;
      return Date.parse(message.processAfter) <= now;
    }).length;
  }

  enqueueOutbound(session: SessionRef, message: OutboundMessage): void {
    const k = this.key(session);
    const list = this.outbound.get(k) ?? [];
    list.push({ ...message });
    this.outbound.set(k, list);
    this.touch(k);
  }

  pollOutbound(session: SessionRef): OutboundMessage[] {
    const k = this.key(session);
    this.touch(k);
    return [...(this.outbound.get(k) ?? [])];
  }

  /** Remove outbound messages once the host has delivered them (splice-on-ack). */
  ackDelivered(session: SessionRef, messageIds: string[]): void {
    const k = this.key(session);
    if (messageIds.length === 0) {
      this.touch(k);
      return;
    }
    const remove = new Set(messageIds);
    this.outbound.set(
      k,
      (this.outbound.get(k) ?? []).filter((m) => !remove.has(m.id)),
    );
    this.touch(k);
  }

  setProcessingAcks(session: SessionRef, acks: ProcessingAck[]): void {
    const k = this.key(session);
    const merged = new Map((this.acks.get(k) ?? []).map((ack) => [ack.message_id, ack]));
    for (const ack of acks) merged.set(ack.message_id, { ...ack });
    this.acks.set(k, [...merged.values()]);
    this.touch(k);
  }

  getProcessingAcks(session: SessionRef): ProcessingAck[] {
    return [...(this.acks.get(this.key(session)) ?? [])];
  }

  touchHeartbeat(session: SessionRef, at = Date.now()): void {
    const k = this.key(session);
    this.heartbeat.set(k, at);
    this.touch(k, at);
  }

  getLiveness(session: SessionRef): Liveness {
    return { lastHeartbeatAt: this.heartbeat.get(this.key(session)) ?? 0 };
  }

  stageInbox(session: SessionRef, messageId: string, files: Attachment[]): void {
    const k = this.key(session);
    const byMsg = this.inbox.get(k) ?? new Map();
    byMsg.set(
      messageId,
      files.map((f) => ({ ...f })),
    );
    this.inbox.set(k, byMsg);
    this.touch(k);
  }

  getInbox(session: SessionRef, messageId: string): Attachment[] {
    return [...(this.inbox.get(this.key(session))?.get(messageId) ?? [])];
  }

  stageOutbox(session: SessionRef, messageId: string, files: Attachment[]): void {
    const k = this.key(session);
    const byMsg = this.outbox.get(k) ?? new Map();
    byMsg.set(
      messageId,
      files.map((f) => ({ ...f })),
    );
    this.outbox.set(k, byMsg);
    this.touch(k);
  }

  consumeOutbox(session: SessionRef, messageId: string): Attachment[] {
    const k = this.key(session);
    const byMsg = this.outbox.get(k) ?? new Map();
    const files = byMsg.get(messageId) ?? [];
    byMsg.delete(messageId);
    this.outbox.set(k, byMsg);
    this.touch(k);
    return files;
  }

  syncSessionMeta(session: SessionRef, meta: SessionMeta): void {
    const k = this.key(session);
    this.meta.set(k, { ...meta });
    this.touch(k);
  }

  getSessionMeta(session: SessionRef): SessionMeta | undefined {
    return this.meta.get(this.key(session));
  }

  /** Drop all maps for a session key (tests / explicit teardown). */
  evictSession(session: SessionRef): void {
    this.deleteKey(this.key(session));
  }

  /**
   * Remove sessions with no activity for `maxAgeMs`.
   * Call opportunistically from the HTTP server to bound memory.
   */
  sweepStaleSessions(maxAgeMs: number, now = Date.now()): number {
    let removed = 0;
    for (const [k, at] of this.lastActivity) {
      if (now - at > maxAgeMs) {
        this.deleteKey(k);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.inbound.clear();
    this.outbound.clear();
    this.acks.clear();
    this.heartbeat.clear();
    this.inbox.clear();
    this.outbox.clear();
    this.meta.clear();
    this.lastActivity.clear();
  }
}

export const globalHostMailboxStore = new HostMailboxStore();

/**
 * Filesystem transport: delegates to NanoClaw path/DB helpers injected at boot.
 * Keeps package typecheck free of better-sqlite3 while preserving stock semantics.
 */
export interface FilesystemTransportDeps {
  ensureSessionFolder(session: SessionRef): void;
  enqueueInbound(session: SessionRef, message: InboundMessage): void;
  pollOutbound(session: SessionRef): OutboundMessage[];
  ackDelivered(
    session: SessionRef,
    messageIds: string[],
    platformMessageIds?: Array<string | null>,
  ): void;
  getProcessingAcks(session: SessionRef): ProcessingAck[];
  getLiveness(session: SessionRef): Liveness;
  stageInbox(session: SessionRef, messageId: string, files: Attachment[]): void;
  consumeOutbox(session: SessionRef, messageId: string): Attachment[];
  syncSessionMeta?(session: SessionRef, meta: SessionMeta): void;
  /** Optional: clear outbox dir after consume (stock delivery does this). */
  clearOutbox?(session: SessionRef, messageId: string): void;
  countDueInbound?(session: SessionRef): number;
}

export function createFilesystemTransport(deps: FilesystemTransportDeps): SessionTransport {
  return {
    enqueueInbound(session, message) {
      deps.ensureSessionFolder(session);
      deps.enqueueInbound(session, message);
    },
    pollOutbound(session) {
      return deps.pollOutbound(session);
    },
    ackDelivered(session, messageIds, platformMessageIds) {
      deps.ackDelivered(session, messageIds, platformMessageIds);
    },
    getProcessingAcks(session) {
      return deps.getProcessingAcks(session);
    },
    getLiveness(session) {
      return deps.getLiveness(session);
    },
    stageInbox(session, messageId, files) {
      deps.stageInbox(session, messageId, files);
    },
    consumeOutbox(session, messageId) {
      const files = deps.consumeOutbox(session, messageId);
      deps.clearOutbox?.(session, messageId);
      return files;
    },
    syncSessionMeta(session, meta) {
      deps.syncSessionMeta?.(session, meta);
    },
    countDueInbound(session) {
      return deps.countDueInbound?.(session) ?? 0;
    },
  };
}

/** HTTP/loopback transport backed by HostMailboxStore. */
export function createHttpTransport(
  store: HostMailboxStore = globalHostMailboxStore,
): SessionTransport {
  return {
    enqueueInbound(session, message) {
      store.enqueueInbound(session, message);
    },
    pollOutbound(session) {
      return store.pollOutbound(session);
    },
    ackDelivered(session, messageIds) {
      store.ackDelivered(session, messageIds);
    },
    getProcessingAcks(session) {
      return store.getProcessingAcks(session);
    },
    getLiveness(session) {
      return store.getLiveness(session);
    },
    stageInbox(session, messageId, files) {
      store.stageInbox(session, messageId, files);
    },
    consumeOutbox(session, messageId) {
      return store.consumeOutbox(session, messageId);
    },
    syncSessionMeta(session, meta) {
      store.syncSessionMeta(session, meta);
    },
    countDueInbound(session) {
      return store.countDueInbound(session);
    },
  };
}

/** Helper for tests / conformance: write a tiny heartbeat file and read mtime. */
export function filesystemHeartbeatLiveness(heartbeatFile: string): Liveness {
  try {
    return { lastHeartbeatAt: fs.statSync(heartbeatFile).mtimeMs };
  } catch {
    return { lastHeartbeatAt: 0 };
  }
}

export function touchHeartbeatFile(heartbeatFile: string): void {
  fs.mkdirSync(path.dirname(heartbeatFile), { recursive: true });
  const now = new Date();
  fs.writeFileSync(heartbeatFile, '');
  fs.utimesSync(heartbeatFile, now, now);
}
