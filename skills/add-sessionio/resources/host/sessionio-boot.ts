/**
 * Boot entry — register built-in transports and optionally start the HTTP mailbox server.
 * Copied into NanoClaw fork as `src/sessionio-boot.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { startSessionioHttpServer } from './http-server.js';
import {
  registerSessionTransport,
  setDefaultSessionTransport,
  resolveTransportName,
} from './sessionio.js';
import {
  createFilesystemTransport,
  createHttpTransport,
  globalHostMailboxStore,
} from './transports.js';
import type { Attachment, InboundMessage, SessionMeta, SessionRef } from './types.js';

import {
  clearOutbox,
  filesystemWriteSessionMessage,
  heartbeatPath,
  initSessionFolder,
  inboundDbPath,
  openInboundDb,
  openOutboundDb,
  readOutboxFiles,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import {
  getDeliveredIds,
  getDueOutboundMessages,
  getProcessingClaims,
  markDelivered,
  replaceDestinations,
  syncProcessingAcks,
  countDueMessages,
} from './db/session-db.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';
import { onShutdown } from './response-registry.js';

const SESSIONIO_ENV_KEYS = [
  'SESSIONIO_TRANSPORT',
  'SESSIONIO_HTTP_HOST',
  'SESSIONIO_HTTP_PORT',
  'SESSIONIO_BASE_URL',
  'SESSIONIO_HTTP_TOKEN',
] as const;

/** Apply .env SESSIONIO_* into process.env when unset (NanoClaw does not dotenv-load). */
function applySessionioEnvFromFile(): void {
  const fromFile = readEnvFile([...SESSIONIO_ENV_KEYS]);
  for (const key of SESSIONIO_ENV_KEYS) {
    const value = fromFile[key];
    if (value && !process.env[key]?.trim()) {
      process.env[key] = value;
    }
  }
}

function createNanoclawFilesystemDeps() {
  return {
    ensureSessionFolder(session: SessionRef) {
      if (!fs.existsSync(inboundDbPath(session.agentGroupId, session.sessionId))) {
        initSessionFolder(session.agentGroupId, session.sessionId);
      }
    },
    enqueueInbound(session: SessionRef, message: InboundMessage) {
      filesystemWriteSessionMessage(session.agentGroupId, session.sessionId, message);
    },
    pollOutbound(session: SessionRef) {
      try {
        const outDb = openOutboundDb(session.agentGroupId, session.sessionId);
        const inDb = openInboundDb(session.agentGroupId, session.sessionId);
        try {
          const due = getDueOutboundMessages(outDb);
          const delivered = getDeliveredIds(inDb);
          return due.filter((m) => !delivered.has(m.id));
        } finally {
          outDb.close();
          inDb.close();
        }
      } catch {
        return [];
      }
    },
    ackDelivered(
      session: SessionRef,
      messageIds: string[],
      platformMessageIds?: Array<string | null>,
    ) {
      const inDb = openInboundDb(session.agentGroupId, session.sessionId);
      try {
        messageIds.forEach((id, index) => {
          markDelivered(inDb, id, platformMessageIds?.[index] ?? null);
        });
      } finally {
        inDb.close();
      }
    },
    getProcessingAcks(session: SessionRef) {
      try {
        const outDb = openOutboundDb(session.agentGroupId, session.sessionId);
        const inDb = openInboundDb(session.agentGroupId, session.sessionId);
        try {
          syncProcessingAcks(inDb, outDb);
          return getProcessingClaims(outDb).map((claim) => ({
            message_id: claim.message_id,
            status: 'processing',
            claimed_at: claim.status_changed,
          }));
        } finally {
          outDb.close();
          inDb.close();
        }
      } catch {
        return [];
      }
    },
    getLiveness(session: SessionRef) {
      try {
        return {
          lastHeartbeatAt: fs.statSync(heartbeatPath(session.agentGroupId, session.sessionId))
            .mtimeMs,
        };
      } catch {
        return { lastHeartbeatAt: 0 };
      }
    },
    stageInbox() {
      // filesystemWriteSessionMessage stages inbox attachments.
    },
    consumeOutbox(session: SessionRef, messageId: string): Attachment[] {
      const outboxDir = path.join(
        sessionDir(session.agentGroupId, session.sessionId),
        'outbox',
        messageId,
      );
      let filenames: string[] = [];
      try {
        filenames = fs.readdirSync(outboxDir).filter((name) => {
          try {
            return fs.statSync(path.join(outboxDir, name)).isFile();
          } catch {
            return false;
          }
        });
      } catch {
        return [];
      }
      if (filenames.length === 0) return [];
      const files = readOutboxFiles(
        session.agentGroupId,
        session.sessionId,
        messageId,
        filenames,
      );
      if (!files) return [];
      return files.map((f) => ({
        name: f.filename,
        data: f.data.toString('base64'),
      }));
    },
    clearOutbox(session: SessionRef, messageId: string) {
      clearOutbox(session.agentGroupId, session.sessionId, messageId);
    },
    syncSessionMeta(session: SessionRef, meta: SessionMeta) {
      if (meta.destinations) {
        const db = openInboundDb(session.agentGroupId, session.sessionId);
        try {
          replaceDestinations(db, meta.destinations);
        } finally {
          db.close();
        }
      }
      writeSessionRouting(session.agentGroupId, session.sessionId);
    },
    countDueInbound(session: SessionRef) {
      try {
        const inDb = openInboundDb(session.agentGroupId, session.sessionId);
        try {
          return countDueMessages(inDb);
        } finally {
          inDb.close();
        }
      } catch {
        return 0;
      }
    },
  };
}

let httpStarted = false;

export async function startSessionio(): Promise<void> {
  applySessionioEnvFromFile();

  registerSessionTransport('filesystem', createFilesystemTransport(createNanoclawFilesystemDeps()));
  registerSessionTransport('http', createHttpTransport(globalHostMailboxStore));
  registerSessionTransport('loopback', createHttpTransport(globalHostMailboxStore));

  const desired = resolveTransportName({ agentGroupId: '_', sessionId: '_' });
  setDefaultSessionTransport(desired === 'http' ? 'http' : 'filesystem');

  if ((desired === 'http' || process.env.SESSIONIO_TRANSPORT === 'loopback') && !httpStarted) {
    // 0.0.0.0 so Docker agents can reach the host via host.docker.internal.
    const host = process.env.SESSIONIO_HTTP_HOST ?? '0.0.0.0';
    const started = await startSessionioHttpServer({
      host,
      port: Number(process.env.SESSIONIO_HTTP_PORT ?? '18765'),
      token: process.env.SESSIONIO_HTTP_TOKEN,
      store: globalHostMailboxStore,
    });
    httpStarted = true;
    const advertiseHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    process.env.SESSIONIO_BASE_URL =
      process.env.SESSIONIO_BASE_URL ?? `http://${advertiseHost}:${started.port}`;
    log.info('Sessionio HTTP mailbox listening', {
      bind: `${host}:${started.port}`,
      baseUrl: process.env.SESSIONIO_BASE_URL,
      transport: desired,
    });
    onShutdown(async () => {
      await new Promise<void>((resolve, reject) => {
        started.server.close((err) => (err ? reject(err) : resolve()));
      });
    });
  } else {
    log.info('Sessionio ready', { defaultTransport: desired });
  }
}
