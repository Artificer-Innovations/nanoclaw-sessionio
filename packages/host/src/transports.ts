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

/**
 * Host-side in-memory queue store used by the HTTP / loopback transport.
 * Source of truth lives on the host — agents never share SQLite mounts.
 */
export class HostMailboxStore {
  private inbound = new Map<string, InboundMessage[]>();
  private outbound = new Map<string, OutboundMessage[]>();
  private delivered = new Map<string, Set<string>>();
  private acks = new Map<string, ProcessingAck[]>();
  private heartbeat = new Map<string, number>();
  private inbox = new Map<string, Map<string, Attachment[]>>();
  private outbox = new Map<string, Map<string, Attachment[]>>();
  private meta = new Map<string, SessionMeta>();

  private key(session: SessionRef): string {
    return `${session.agentGroupId}::${session.sessionId}`;
  }

  enqueueInbound(session: SessionRef, message: InboundMessage): void {
    const k = this.key(session);
    const list = this.inbound.get(k) ?? [];
    list.push({ ...message });
    this.inbound.set(k, list);
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
    return taken;
  }

  countDueInbound(session: SessionRef): number {
    const now = Date.now();
    return (this.inbound.get(this.key(session)) ?? []).filter((message) => {
      if (message.processAfter && Date.parse(message.processAfter) > now) return false;
      return true;
    }).length;
  }

  enqueueOutbound(session: SessionRef, message: OutboundMessage): void {
    const k = this.key(session);
    const list = this.outbound.get(k) ?? [];
    list.push({ ...message });
    this.outbound.set(k, list);
  }

  pollOutbound(session: SessionRef): OutboundMessage[] {
    const k = this.key(session);
    const delivered = this.delivered.get(k) ?? new Set();
    return (this.outbound.get(k) ?? []).filter((m) => !delivered.has(m.id));
  }

  ackDelivered(session: SessionRef, messageIds: string[]): void {
    const k = this.key(session);
    const delivered = this.delivered.get(k) ?? new Set();
    for (const id of messageIds) delivered.add(id);
    this.delivered.set(k, delivered);
  }

  setProcessingAcks(session: SessionRef, acks: ProcessingAck[]): void {
    const k = this.key(session);
    const merged = new Map((this.acks.get(k) ?? []).map((ack) => [ack.message_id, ack]));
    for (const ack of acks) merged.set(ack.message_id, { ...ack });
    this.acks.set(k, [...merged.values()]);
  }

  getProcessingAcks(session: SessionRef): ProcessingAck[] {
    return [...(this.acks.get(this.key(session)) ?? [])];
  }

  touchHeartbeat(session: SessionRef, at = Date.now()): void {
    this.heartbeat.set(this.key(session), at);
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
  }

  consumeOutbox(session: SessionRef, messageId: string): Attachment[] {
    const k = this.key(session);
    const byMsg = this.outbox.get(k) ?? new Map();
    const files = byMsg.get(messageId) ?? [];
    byMsg.delete(messageId);
    this.outbox.set(k, byMsg);
    return files;
  }

  syncSessionMeta(session: SessionRef, meta: SessionMeta): void {
    this.meta.set(this.key(session), { ...meta });
  }

  getSessionMeta(session: SessionRef): SessionMeta | undefined {
    return this.meta.get(this.key(session));
  }

  clear(): void {
    this.inbound.clear();
    this.outbound.clear();
    this.delivered.clear();
    this.acks.clear();
    this.heartbeat.clear();
    this.inbox.clear();
    this.outbox.clear();
    this.meta.clear();
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
