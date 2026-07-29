export const SESSIONIO_API_VERSION = 1 as const;

export type SessionTransportName = 'filesystem' | 'http' | 'loopback' | (string & {});

export interface SessionRef {
  agentGroupId: string;
  sessionId: string;
  /** Optional per-group / per-session override; falls back to env / default. */
  transportName?: string;
}

export interface InboundMessage {
  id: string;
  kind: string;
  timestamp: string;
  platformId?: string | null;
  channelType?: string | null;
  threadId?: string | null;
  content: string;
  processAfter?: string | null;
  recurrence?: string | null;
  trigger?: 0 | 1;
  sourceSessionId?: string | null;
  onWake?: 0 | 1;
}

export interface OutboundMessage {
  id: string;
  kind: string;
  /** Present on wire / HTTP store; optional when reading stock SQLite rows. */
  timestamp?: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  in_reply_to: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  seq?: number;
}

export interface ProcessingAck {
  message_id: string;
  status: string;
  claimed_at?: string | null;
  [key: string]: unknown;
}

export interface Liveness {
  lastHeartbeatAt: number;
}

export interface Attachment {
  name: string;
  data?: string;
  localPath?: string;
  type?: string;
  [key: string]: unknown;
}

export interface SessionMeta {
  routing?: {
    channel_type: string | null;
    platform_id: string | null;
    thread_id: string | null;
  };
  destinations?: Array<{
    name: string;
    display_name: string | null;
    type: 'channel' | 'agent';
    channel_type: string | null;
    platform_id: string | null;
    agent_group_id: string | null;
  }>;
}

export interface SessionTransport {
  enqueueInbound(session: SessionRef, message: InboundMessage): Promise<void> | void;
  pollOutbound(session: SessionRef): Promise<OutboundMessage[]> | OutboundMessage[];
  ackDelivered(
    session: SessionRef,
    messageIds: string[],
    platformMessageIds?: Array<string | null>,
  ): Promise<void> | void;
  getProcessingAcks(session: SessionRef): Promise<ProcessingAck[]> | ProcessingAck[];
  getLiveness(session: SessionRef): Promise<Liveness> | Liveness;
  stageInbox(session: SessionRef, messageId: string, files: Attachment[]): Promise<void> | void;
  consumeOutbox(session: SessionRef, messageId: string): Promise<Attachment[]> | Attachment[];
  syncSessionMeta?(session: SessionRef, meta: SessionMeta): Promise<void> | void;
  /** Pending inbound count used by host-sweep to decide whether to wake. */
  countDueInbound?(session: SessionRef): number | Promise<number>;
}

/** Logical wire fields shared by HTTP peer protocol (mirrors messages_in / messages_out). */
export interface SessionioWireInbound extends InboundMessage {}
export interface SessionioWireOutbound extends OutboundMessage {}

export function normalizeTransportName(name: string | undefined | null): string {
  const trimmed = (name ?? '').trim().toLowerCase();
  if (!trimmed) return 'filesystem';
  if (trimmed === 'loopback') return 'http';
  return trimmed;
}
