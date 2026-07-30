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
import Database from 'better-sqlite3';

const deliveryAttempts = new Map<string, number>();
const MAX_DELIVERY_ATTEMPTS = 5;

function getAgentGroup(_id: string) {
  return { id: 'ag' };
}
function openOutboundDb(_a: string, _s: string): Database.Database {
  return {} as Database.Database;
}
function openInboundDb(_a: string, _s: string): Database.Database {
  return {} as Database.Database;
}
function getDueOutboundMessages(_db: Database.Database) {
  return [] as Array<{ id: string; kind: string; channel_type: string | null }>;
}
function getDeliveredIds(_db: Database.Database) {
  return new Set<string>();
}
function migrateDeliveredTable(_db: Database.Database) {}
function markDelivered(_db: Database.Database, _id: string, _p: string | null) {}
function markDeliveryFailed(_db: Database.Database, _id: string) {}
function pauseTypingRefreshAfterDelivery(_id: string) {}
async function deliverMessage(_msg: unknown, _session: Session, _inDb: Database.Database) {
  return null;
}
const log = { error: (..._a: unknown[]) => undefined, warn: (..._a: unknown[]) => undefined };

async function drainSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let outDb: Database.Database;
  let inDb: Database.Database;
  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return; // DBs might not exist yet
  }

  try {
    // Read all due messages from outbound.db (read-only)
    const allDue = getDueOutboundMessages(outDb);
    if (allDue.length === 0) return;

    // Filter out already-delivered messages using inbound.db's delivered table
    const delivered = getDeliveredIds(inDb);
    const undelivered = allDue.filter((m) => !delivered.has(m.id));
    if (undelivered.length === 0) return;

    // Ensure platform_message_id column exists (migration for existing sessions)
    migrateDeliveredTable(inDb);

    for (const msg of undelivered) {
      try {
        const platformMsgId = await deliverMessage(msg, session, inDb);
        markDelivered(inDb, msg.id, platformMsgId ?? null);
        deliveryAttempts.delete(msg.id);

        // Pause the typing indicator after a real user-facing message
        // lands on the user's screen, so the client has time to visually
        // clear the indicator before the next heartbeat tick brings it
        // back. Skip the pause for internal traffic (system actions,
        // agent-to-agent routing) — the user doesn't see those and
        // shouldn't get a gap in their typing indicator for them.
        if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
          pauseTypingRefreshAfterDelivery(session.id);
        }
      } catch (err) {
        const attempts = (deliveryAttempts.get(msg.id) ?? 0) + 1;
        deliveryAttempts.set(msg.id, attempts);
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          log.error('Message delivery failed permanently, giving up', {
            messageId: msg.id,
            sessionId: session.id,
            attempts,
            err,
          });
          markDeliveryFailed(inDb, msg.id);
          deliveryAttempts.delete(msg.id);
        } else {
          log.warn('Message delivery failed, will retry', {
            messageId: msg.id,
            sessionId: session.id,
            attempt: attempts,
            maxAttempts: MAX_DELIVERY_ATTEMPTS,
            err,
          });
        }
      }
    }
  } finally {
    outDb.close();
    inDb.close();
  }
}

async function deliverMessage(
  msg: { id: string; content: string },
  session: Session,
  inDb: Database.Database,
): Promise<string | null> {
  void inDb;
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

export function writeMessageOut(msg: WriteMessageOut): number {
  const outbound = getOutboundDb();
  const inbound = getInboundDb();
  void inbound;
  void msg;
  void outbound;
  return 1;
}
`;
