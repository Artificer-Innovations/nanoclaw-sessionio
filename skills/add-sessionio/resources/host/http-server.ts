import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_SESSION_STALE_MS,
  globalHostMailboxStore,
  type HostMailboxStore,
} from './transports.js';
import { warnOnce } from './warn-once.js';
import type {
  InboundMessage,
  OutboundMessage,
  ProcessingAck,
  SessionMeta,
  SessionRef,
} from './types.js';

/** Max JSON body size for mailbox POSTs (attachments are base64 in JSON). */
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Paths that require agentGroupId + sessionId query params. */
const SESSION_PATHS = new Set([
  '/inbound',
  '/outbound',
  '/outbound/ack',
  '/acks',
  '/heartbeat',
  '/liveness',
  '/inbox',
  '/outbox',
  '/meta',
]);

export interface SessionioHttpServerOptions {
  host?: string;
  port?: number;
  token?: string;
  store?: HostMailboxStore;
  maxBodyBytes?: number;
  /** Idle session map TTL; swept opportunistically on each request. */
  sessionStaleMs?: number;
}

export class RequestBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`request body too large (max ${maxBytes} bytes)`);
    this.name = 'RequestBodyTooLargeError';
  }
}

export function readBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<string> {
  const contentLength = Number(req.headers['content-length'] ?? '');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return Promise.reject(new RequestBodyTooLargeError(maxBytes));
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(error);
    };

    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        fail(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
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

/** 204 No Content must not include a message body. */
function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
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

/** Constant-time Bearer comparison (length mismatch fails closed). */
export function bearerTokenMatches(header: string, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Resolve Host header for request URL parsing (testable). */
export function requestHost(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  return raw || '127.0.0.1';
}

/** Normalize request path; trailing-slash-only paths become `/`. */
export function requestPathname(urlPath: string | undefined): string {
  const pathOnly = (urlPath ?? '/').split('?')[0] || '/';
  return pathOnly.replace(/\/+$/, '') || '/';
}

export function buildRequestUrl(reqUrl: string | undefined, host: string): URL {
  return new URL(reqUrl || '/', `http://${host}`);
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

export function createSessionioHttpServer(options: SessionioHttpServerOptions = {}): http.Server {
  const store = options.store ?? globalHostMailboxStore;
  const token = options.token ?? process.env.SESSIONIO_HTTP_TOKEN ?? '';
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const sessionStaleMs = options.sessionStaleMs ?? DEFAULT_SESSION_STALE_MS;
  let lastSweepAt = 0;

  return http.createServer(async (req, res) => {
    try {
      if (token) {
        const header = req.headers.authorization ?? '';
        if (!bearerTokenMatches(header, token)) {
          unauthorized(res);
          return;
        }
      }

      const now = Date.now();
      if (now - lastSweepAt > 30_000) {
        store.sweepStaleSessions(sessionStaleMs, now);
        lastSweepAt = now;
      }

      const host = requestHost(req.headers.host);
      const url = buildRequestUrl(req.url, host);
      const pathname = requestPathname(req.url);

      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Session routes only — unknown paths must 404 before parseSession,
      // otherwise missing query params would mask them as 400.
      if (!SESSION_PATHS.has(pathname)) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }

      const session = parseSession(url);

      if (req.method === 'POST' && pathname === '/inbound') {
        const message = JSON.parse(await readBody(req, maxBodyBytes)) as InboundMessage;
        store.enqueueInbound(session, message);
        sendNoContent(res);
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
        const message = JSON.parse(await readBody(req, maxBodyBytes)) as OutboundMessage;
        store.enqueueOutbound(session, message);
        sendNoContent(res);
        return;
      }

      if (req.method === 'GET' && pathname === '/outbound') {
        sendJson(res, 200, { messages: store.pollOutbound(session) });
        return;
      }

      if (req.method === 'POST' && pathname === '/outbound/ack') {
        const body = JSON.parse(await readBody(req, maxBodyBytes)) as {
          messageIds?: string[];
          platformMessageIds?: Array<string | null>;
        };
        store.ackDelivered(session, body.messageIds ?? [], body.platformMessageIds);
        sendNoContent(res);
        return;
      }

      if (req.method === 'POST' && pathname === '/acks') {
        const body = JSON.parse(await readBody(req, maxBodyBytes)) as { acks?: ProcessingAck[] };
        store.setProcessingAcks(session, body.acks ?? []);
        sendNoContent(res);
        return;
      }

      if (req.method === 'GET' && pathname === '/acks') {
        sendJson(res, 200, { acks: store.getProcessingAcks(session) });
        return;
      }

      if (req.method === 'POST' && pathname === '/heartbeat') {
        store.touchHeartbeat(session);
        sendNoContent(res);
        return;
      }

      if (req.method === 'GET' && pathname === '/liveness') {
        sendJson(res, 200, store.getLiveness(session));
        return;
      }

      if (req.method === 'POST' && pathname === '/inbox') {
        const body = JSON.parse(await readBody(req, maxBodyBytes)) as {
          messageId: string;
          files: Parameters<HostMailboxStore['stageInbox']>[2];
        };
        store.stageInbox(session, body.messageId, body.files ?? []);
        sendNoContent(res);
        return;
      }

      if (req.method === 'GET' && pathname === '/inbox') {
        const messageId = url.searchParams.get('messageId') ?? '';
        sendJson(res, 200, { files: store.getInbox(session, messageId) });
        return;
      }

      if (req.method === 'POST' && pathname === '/outbox') {
        const body = JSON.parse(await readBody(req, maxBodyBytes)) as {
          messageId: string;
          files: Parameters<HostMailboxStore['stageOutbox']>[2];
        };
        store.stageOutbox(session, body.messageId, body.files ?? []);
        sendNoContent(res);
        return;
      }

      if (req.method === 'GET' && pathname === '/outbox') {
        const messageId = url.searchParams.get('messageId') ?? '';
        sendJson(res, 200, { files: store.consumeOutbox(session, messageId) });
        return;
      }

      if (req.method === 'POST' && pathname === '/meta') {
        const meta = JSON.parse(await readBody(req, maxBodyBytes)) as SessionMeta;
        store.syncSessionMeta(session, meta);
        sendNoContent(res);
        return;
      }

      if (req.method === 'GET' && pathname === '/meta') {
        sendJson(res, 200, store.getSessionMeta(session) ?? {});
        return;
      }

      // Known path but wrong method (e.g. PUT /inbound).
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
      sendJson(res, status, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export function resolveListenHost(
  optionsHost: string | undefined,
  envHost: string | undefined = process.env.SESSIONIO_HTTP_HOST,
): string {
  return optionsHost ?? envHost ?? '127.0.0.1';
}

export function resolveListenPort(
  optionsPort: number | undefined,
  envPort: string | undefined = process.env.SESSIONIO_HTTP_PORT,
): number {
  if (optionsPort != null) return optionsPort;
  const parsed = Number(envPort ?? '18765');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 18765;
}

export function boundPortFromAddress(
  address: string | { port: number } | null,
  fallback: number,
): number {
  return typeof address === 'object' && address ? address.port : fallback;
}

export async function startSessionioHttpServer(
  options: SessionioHttpServerOptions = {},
): Promise<{ server: http.Server; host: string; port: number; baseUrl: string }> {
  const host = resolveListenHost(options.host);
  const port = resolveListenPort(options.port);
  const token = options.token ?? process.env.SESSIONIO_HTTP_TOKEN ?? '';
  if (!token && !isLoopbackHost(host)) {
    warnOnce(
      'sessionio-http-no-token',
      `SESSIONIO_HTTP_TOKEN is unset while binding ${host} — mailbox accepts unauthenticated reads/writes for any agentGroupId/sessionId. The token is a shared bearer, not a tenant boundary; isolation belongs to the per-tenant host process.`,
    );
  }
  const server = createSessionioHttpServer(options);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const boundPort = boundPortFromAddress(server.address(), port);
  return {
    server,
    host,
    port: boundPort,
    baseUrl: `http://${host}:${boundPort}`,
  };
}
