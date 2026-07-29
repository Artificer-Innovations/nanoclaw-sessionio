/**
 * Helpers for poll-loop ↔ HTTP peer bridging (no NanoClaw DB imports).
 */
import type { InboundMessage, OutboundMessage, SessionRef } from './types.js';

export interface SessionioPendingRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export interface SessionioWriteOut {
  id: string;
  in_reply_to?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
}

export function sessionRefFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fallbackAgentGroupId = '',
): SessionRef {
  const sessionId = env.SESSIONIO_SESSION_ID?.trim();
  const agentGroupId = env.SESSIONIO_AGENT_GROUP_ID?.trim() || fallbackAgentGroupId.trim();
  if (!sessionId) {
    throw new Error('SESSIONIO_SESSION_ID is required when SESSIONIO_TRANSPORT is http/loopback');
  }
  if (!agentGroupId) {
    throw new Error(
      'SESSIONIO_AGENT_GROUP_ID (or container.json agentGroupId) is required when SESSIONIO_TRANSPORT is http/loopback',
    );
  }
  return { agentGroupId, sessionId };
}

export function inboundWireToRow(message: InboundMessage): SessionioPendingRow {
  return {
    id: message.id,
    seq: null,
    kind: message.kind,
    timestamp: message.timestamp,
    status: 'pending',
    process_after: message.processAfter ?? null,
    recurrence: message.recurrence ?? null,
    tries: 0,
    trigger: message.trigger ?? 1,
    platform_id: message.platformId ?? null,
    channel_type: message.channelType ?? null,
    thread_id: message.threadId ?? null,
    content: message.content,
  };
}

export function writeToOutboundWire(message: SessionioWriteOut): OutboundMessage {
  return {
    id: message.id,
    kind: message.kind,
    timestamp: new Date().toISOString(),
    platform_id: message.platform_id ?? null,
    channel_type: message.channel_type ?? null,
    thread_id: message.thread_id ?? null,
    content: message.content,
    in_reply_to: message.in_reply_to ?? null,
    deliver_after: message.deliver_after ?? null,
    recurrence: message.recurrence ?? null,
  };
}
