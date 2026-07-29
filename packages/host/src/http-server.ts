import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { globalHostMailboxStore, type HostMailboxStore } from './transports.js';
import type {
  InboundMessage,
  OutboundMessage,
  ProcessingAck,
  SessionMeta,
  SessionRef,
} from './types.js';

export interface SessionioHttpServerOptions {
  host?: string;
  port?: number;
  token?: string;
  store?: HostMailboxStore;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parseSession(url: URL): SessionRef {
  const agentGroupId = url.searchParams.get('agentGroupId') ?? '';
  const sessionId = url.searchParams.get('sessionId') ?? '';
  if (!agentGroupId || !sessionId) {
    throw new Error('agentGroupId and sessionId query params are required');
  }
  return { agentGroupId, sessionId };
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { error: 'unauthorized' });
}

export function createSessionioHttpServer(options: SessionioHttpServerOptions = {}): http.Server {
  const store = options.store ?? globalHostMailboxStore;
  const token = options.token ?? process.env.SESSIONIO_HTTP_TOKEN ?? '';

  return http.createServer(async (req, res) => {
    try {
      if (token) {
        const header = req.headers.authorization ?? '';
        if (header !== `Bearer ${token}`) {
          unauthorized(res);
          return;
        }
      }

      const host = req.headers.host ?? '127.0.0.1';
      const url = new URL(req.url ?? '/', `http://${host}`);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const session = parseSession(url);

      if (req.method === 'POST' && pathname === '/inbound') {
        const message = JSON.parse(await readBody(req)) as InboundMessage;
        store.enqueueInbound(session, message);
        sendJson(res, 204, null);
        return;
      }

      if (req.method === 'GET' && pathname === '/inbound') {
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw != null ? Number(limitRaw) : undefined;
        sendJson(res, 200, {
          messages: store.takeInbound(session, {
            limit: Number.isFinite(limit) ? limit : undefined,
            isFirstPoll: url.searchParams.get('isFirstPoll') === '1',
          }),
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/outbound') {
        const message = JSON.parse(await readBody(req)) as OutboundMessage;
        store.enqueueOutbound(session, message);
        sendJson(res, 204, null);
        return;
      }

      if (req.method === 'GET' && pathname === '/outbound') {
        sendJson(res, 200, { messages: store.pollOutbound(session) });
        return;
      }

      if (req.method === 'POST' && pathname === '/outbound/ack') {
        const body = JSON.parse(await readBody(req)) as { messageIds?: string[] };
        store.ackDelivered(session, body.messageIds ?? []);
        sendJson(res, 204, null);
        return;
      }

      if (req.method === 'POST' && pathname === '/acks') {
        const body = JSON.parse(await readBody(req)) as { acks?: ProcessingAck[] };
        store.setProcessingAcks(session, body.acks ?? []);
        sendJson(res, 204, null);
        return;
      }

      if (req.method === 'GET' && pathname === '/acks') {
        sendJson(res, 200, { acks: store.getProcessingAcks(session) });
        return;
      }

      if (req.method === 'POST' && pathname === '/heartbeat') {
        store.touchHeartbeat(session);
        sendJson(res, 204, null);
        return;
      }

      if (req.method === 'GET' && pathname === '/liveness') {
        sendJson(res, 200, store.getLiveness(session));
        return;
      }

      if (req.method === 'POST' && pathname === '/inbox') {
        const body = JSON.parse(await readBody(req)) as {
          messageId: string;
          files: Parameters<HostMailboxStore['stageInbox']>[2];
        };
        store.stageInbox(session, body.messageId, body.files ?? []);
        sendJson(res, 204, null);
        return;
      }

      if (req.method === 'GET' && pathname === '/inbox') {
        const messageId = url.searchParams.get('messageId') ?? '';
        sendJson(res, 200, { files: store.getInbox(session, messageId) });
        return;
      }

      if (req.method === 'POST' && pathname === '/outbox') {
        const body = JSON.parse(await readBody(req)) as {
          messageId: string;
          files: Parameters<HostMailboxStore['stageOutbox']>[2];
        };
        store.stageOutbox(session, body.messageId, body.files ?? []);
        sendJson(res, 204, null);
        return;
      }

      if (req.method === 'GET' && pathname === '/outbox') {
        const messageId = url.searchParams.get('messageId') ?? '';
        sendJson(res, 200, { files: store.consumeOutbox(session, messageId) });
        return;
      }

      if (req.method === 'POST' && pathname === '/meta') {
        const meta = JSON.parse(await readBody(req)) as SessionMeta;
        store.syncSessionMeta(session, meta);
        sendJson(res, 204, null);
        return;
      }

      if (req.method === 'GET' && pathname === '/meta') {
        sendJson(res, 200, store.getSessionMeta(session) ?? {});
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export async function startSessionioHttpServer(
  options: SessionioHttpServerOptions = {},
): Promise<{ server: http.Server; host: string; port: number; baseUrl: string }> {
  const host = options.host ?? process.env.SESSIONIO_HTTP_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.SESSIONIO_HTTP_PORT ?? '18765');
  const server = createSessionioHttpServer(options);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    host,
    port: boundPort,
    baseUrl: `http://${host}:${boundPort}`,
  };
}
