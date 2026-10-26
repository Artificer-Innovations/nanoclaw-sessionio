/** Minimal NanoClaw-shaped fixtures for installer unit tests. */

export const STOCK_SESSION_MANAGER = `import fs from 'fs';

export function inboundDbPath(agentGroupId: string, sessionId: string): string {
  return \`/tmp/\${agentGroupId}/\${sessionId}/inbound.db\`;
}

export function initSessionFolder(agentGroupId: string, sessionId: string): void {}

export function writeSessionMessage(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: string;
    timestamp: string;
    content: string;
  },
): void {
  if (!fs.existsSync(inboundDbPath(agentGroupId, sessionId))) {
    initSessionFolder(agentGroupId, sessionId);
  }

  // Extract base64 attachment data, save to inbox, replace with file paths
  const content = message.content;

  const db = { close() {} };
  try {
    void content;
  } finally {
    db.close();
  }

  updateSession(sessionId, { last_active: new Date().toISOString() });
}

/**
 * If message content has attachments with base64 \`data\`, save them to
 * the session's inbox directory and replace with \`localPath\`.
 */
function extractAttachmentFiles(): string {
  return '';
}

function updateSession(_id: string, _patch: { last_active: string }): void {}
`;

export const STOCK_DELIVERY = `import type { Session } from './types.js';

type OutboundMessage = {
  id: string;
  kind: string;
  content: string;
  channelType: string | null;
  platformId?: string | null;
};

const batchPreviewHooks: Array<(msgs: unknown[], session: Session) => Promise<void>> = [];
const postDeliveryHooks: Array<(msg: OutboundMessage, session: Session, meta: { firstDelivery: boolean }) => Promise<void>> = [];
const MAX_DELIVERY_ATTEMPTS = 5;

async function getAgentGroup(_id: string) {
  return { id: 'ag' };
}
async function withExistingMailboxSession<T>(
  _a: string,
  _s: string,
  fn: (mailbox: {
    getDeliveredIds: () => Set<string>;
    getDueMessages: (delivered: Set<string>) => OutboundMessage[];
    markDelivered: (id: string, platformMsgId: string | null) => void;
    markDeliveryFailed: (id: string) => void;
  }) => T,
): Promise<T | null> {
  return fn({
    getDeliveredIds: () => new Set(),
    getDueMessages: () => [],
    markDelivered: () => undefined,
    markDeliveryFailed: () => undefined,
  });
}
async function deliverMessage(_msg: OutboundMessage, _session: Session) {
  return null;
}
async function clearAttemptRow(_id: string) {}
async function recordAttemptRow(_id: string, _sessionId: string, _err: unknown) {
  return 1;
}
function pauseTypingRefreshAfterDelivery(_id: string) {}
function fanOutboundMessage(_msg: unknown, _session: Session, _group: { id: string }) {}
const log = { error: (..._a: unknown[]) => undefined, warn: (..._a: unknown[]) => undefined };

async function drainSession(session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  // Read the queue in one short mailbox session, then deliver with NO
  // session held open: delivery handlers (agent-to-agent routing, approval
  // notifications, cli_request → dispatch) open their own sessions on this
  // same key, and implementations may serialize session() per key — holding
  // the session across delivery would deadlock them. Same re-entry class the
  // reconciler avoids around requestWake (see reconcile-session.ts).
  let delivered: Set<string>;
  let pending: OutboundMessage[];
  try {
    const existing = await withExistingMailboxSession(agentGroup.id, session.id, (mailbox) => {
      const delivered = mailbox.getDeliveredIds();
      return {
        delivered,
        pending: mailbox.getDueMessages(delivered).filter((candidate) => !delivered.has(candidate.id)),
      };
    });
    if (!existing) return;
    ({ delivered, pending } = existing);
  } catch (err) {
    log.error('Session mailbox delivery failed', {
      agentGroupId: agentGroup.id,
      sessionId: session.id,
      err,
    });
    return;
  }

  for (const hook of batchPreviewHooks) {
    try {
      await hook(
        pending.map(({ kind, content }) => ({ kind, content })),
        session,
      );
    } catch (err) {
      log.warn('Delivery batch-preview hook failed', { sessionId: session.id, err });
    }
  }

  for (const msg of pending) {
    try {
      const platformMsgId = await deliverMessage(msg, session);
      await withExistingMailboxSession(agentGroup.id, session.id, (mailbox) =>
        mailbox.markDelivered(msg.id, platformMsgId ?? null),
      );
      const firstDelivery = delivered.size === 0;
      delivered.add(msg.id);
      await clearAttemptRow(msg.id);
      if (msg.kind !== 'system' && msg.channelType !== 'agent') {
        pauseTypingRefreshAfterDelivery(session.id);
        if (msg.kind !== 'task_log') {
          // Cross-session context: echo the delivered reply into the
          // conversation's recently active sibling sessions. Unawaited — the
          // next part of a multi-part reply must not wait on ambient writes.
          void fanOutboundMessage(
            {
              id: msg.id,
              kind: msg.kind,
              platform_id: msg.platformId,
              channel_type: msg.channelType,
              content: msg.content,
            },
            session,
            agentGroup,
          );
          for (const hook of postDeliveryHooks) {
            try {
              await hook(msg, session, { firstDelivery });
            } catch (err) {
              log.warn('Post-delivery hook failed', { messageId: msg.id, sessionId: session.id, err });
            }
          }
        }
      }
    } catch (err) {
      const attempts = await recordAttemptRow(msg.id, session.id, err);
      if (attempts !== null && attempts >= MAX_DELIVERY_ATTEMPTS) {
        log.error('Message delivery failed permanently, giving up', {
          messageId: msg.id,
          sessionId: session.id,
          attempts,
          err,
        });
        try {
          await withExistingMailboxSession(agentGroup.id, session.id, (mailbox) => mailbox.markDeliveryFailed(msg.id));
          await clearAttemptRow(msg.id);
        } catch (markErr) {
          log.error('Failed to record permanent delivery failure', {
            messageId: msg.id,
            sessionId: session.id,
            err: markErr,
          });
        }
      } else {
        log.warn('Message delivery failed, will retry', {
          messageId: msg.id,
          sessionId: session.id,
          // null: the bookkeeping write itself failed; count unknown this tick.
          attempt: attempts,
          maxAttempts: MAX_DELIVERY_ATTEMPTS,
          err,
        });
      }
    }
  }
}

async function deliverMessage(
  msg: { id: string; content: string },
  session: Session,
): Promise<string | null> {
  const content = JSON.parse(msg.content) as { files?: string[] };

  // Read file attachments from outbox if the content declares files.
  // File I/O lives in session-manager.ts (symmetric with inbound
  // extractAttachmentFiles) — delivery just hands buffers to the adapter.
  const files =
    Array.isArray(content.files) && content.files.length > 0
      ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
      : undefined;

  void files;
  return null;
}

function readOutboxFiles(
  _agentGroupId: string,
  _sessionId: string,
  _messageId: string,
  _names: string[],
): Array<{ filename: string; data: Buffer }> {
  return [];
}
`;

export const STOCK_CONTAINER_RUNNER = `import { writeSessionRouting } from './session-manager.js';

export async function wakeContainer(agentGroup: { id: string; name: string }, session: { id: string; agent_group_id?: string; thread_id?: string | null }, containerName: string): Promise<void> {
  if (false) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  const args: string[] = [];
  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });
}

/** Shape after agenthosts public-exports: slot for sessionio wake meta sync. */
export async function wakeContainerFromAgenthosts(session: { id: string; agent_group_id: string; thread_id?: string | null }): Promise<boolean> {
  writeSessionRouting(session.agent_group_id, session.id);
    // @nanoclaw-sessionio:wake-prepare-meta-slot
  return true;
}

const log = { info: (..._a: unknown[]) => undefined };
`;

export const STOCK_HOST_SWEEP = `import fs from 'fs';
import { heartbeatPath } from './session-manager.js';

async function sweepSession(session: { id: string }, agentGroup: { id: string }, inDb: { close(): void }): Promise<void> {
  try {
    const dueCount = countDueMessages(inDb);
    void dueCount;
    void session;
    void agentGroup;
  } finally {
    inDb.close();
  }
}

function countDueMessages(_inDb: { close(): void }): number {
  return 0;
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

export { heartbeatMtimeMs, sweepSession };
`;

export const STOCK_INDEX = `async function main(): Promise<void> {
  log.info('NanoClaw starting');

  startActiveDeliveryPoll();
  startSweepDeliveryPoll();

  startHostSweep();
}

const log = { info: (..._a: unknown[]) => undefined };
function startActiveDeliveryPoll() {}
function startSweepDeliveryPoll() {}
function startHostSweep() {}
void main();
`;

export const STOCK_RUNNER_INDEX = `import fs from 'fs';
import { runPollLoop } from './poll-loop.js';

async function main() {
  await runPollLoop({} as never);
}
void main();
`;

export const STOCK_MCP_TOOLS_INDEX = `/**
 * MCP tools barrel — imports each tool module for its side-effect
 * \`registerTools([...])\` call, then starts the MCP server.
 */
import './core.js';
import { startMcpServer } from './server.js';

startMcpServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

export const STOCK_POLL_LOOP = `import { getPendingMessages, markProcessing, markCompleted, markScriptSkipped } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { touchHeartbeat } from './db/connection.js';

export async function runPollLoop(config: unknown): Promise<void> {
  void config;
  const messages = getPendingMessages(true);
  markProcessing(messages.map((m) => m.id));
  writeMessageOut({ id: 'out-1', kind: 'chat', content: 'hi' });
  markCompleted(messages.map((m) => m.id));
  markScriptSkipped([]);
  touchHeartbeat();
}
`;

export const STOCK_MESSAGES_OUT = `import { getInboundDb, getOutboundDb } from './connection.js';

export interface WriteMessageOut {
  id: string;
  kind: string;
  content: string;
  in_reply_to?: string | null;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
}

export function writeMessageOut(msg: WriteMessageOut): Promise<number> {
  const outbound = getOutboundDb();
  const inbound = getInboundDb();
  void inbound;
  void msg;
  void outbound;
  return Promise.resolve(1);
}
`;
