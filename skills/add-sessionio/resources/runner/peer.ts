import type {
  InboundMessage,
  OutboundMessage,
  ProcessingAck,
  SessionMeta,
  SessionRef,
} from './types.js';

export interface SessionioPeerClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  /** Per-attempt AbortSignal timeout (ms). Default 10s. */
  timeoutMs?: number;
  /** Attempts including the first try. Default 3. */
  maxAttempts?: number;
  /** Base delay for jittered exponential backoff (ms). Default 40. */
  retryBaseMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 40;

function sessionQuery(session: SessionRef): string {
  return `agentGroupId=${encodeURIComponent(session.agentGroupId)}&sessionId=${encodeURIComponent(session.sessionId)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoff(attempt: number, baseMs: number): number {
  const exp = baseMs * 2 ** attempt;
  return exp + Math.floor(Math.random() * baseMs);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class SessionioPeerClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;

  constructor(options: SessionioPeerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  }

  private headers(json = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (json) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  private async fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok || res.status === 204) return res;
        if (isRetryableStatus(res.status) && attempt < this.maxAttempts - 1) {
          await sleep(jitteredBackoff(attempt, this.retryBaseMs));
          continue;
        }
        throw new Error(`${label} failed: ${res.status}`);
      } catch (error) {
        lastError = error;
        if (error instanceof Error && /failed: \d+/.test(error.message)) {
          throw error;
        }
        if (attempt < this.maxAttempts - 1) {
          await sleep(jitteredBackoff(attempt, this.retryBaseMs));
          continue;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
  }

  async pollInbound(
    session: SessionRef,
    options: { limit?: number; isFirstPoll?: boolean } = {},
  ): Promise<InboundMessage[]> {
    const params = new URLSearchParams({
      agentGroupId: session.agentGroupId,
      sessionId: session.sessionId,
    });
    if (options.limit != null) params.set('limit', String(options.limit));
    if (options.isFirstPoll) params.set('isFirstPoll', '1');
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/inbound?${params}`,
      { headers: this.headers() },
      'pollInbound',
    );
    const body = (await res.json()) as { messages: InboundMessage[] };
    return body.messages ?? [];
  }

  async postOutbound(session: SessionRef, message: OutboundMessage): Promise<void> {
    await this.fetchWithRetry(
      `${this.baseUrl}/outbound?${sessionQuery(session)}`,
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(message),
      },
      'postOutbound',
    );
  }

  async heartbeat(session: SessionRef): Promise<void> {
    await this.fetchWithRetry(
      `${this.baseUrl}/heartbeat?${sessionQuery(session)}`,
      {
        method: 'POST',
        headers: this.headers(),
      },
      'heartbeat',
    );
  }

  async postAcks(session: SessionRef, acks: ProcessingAck[]): Promise<void> {
    await this.fetchWithRetry(
      `${this.baseUrl}/acks?${sessionQuery(session)}`,
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ acks }),
      },
      'postAcks',
    );
  }

  async stageOutbox(
    session: SessionRef,
    messageId: string,
    files: Array<{ name: string; data?: string }>,
  ): Promise<void> {
    await this.fetchWithRetry(
      `${this.baseUrl}/outbox?${sessionQuery(session)}`,
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ messageId, files }),
      },
      'stageOutbox',
    );
  }

  async getMeta(session: SessionRef): Promise<SessionMeta> {
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/meta?${sessionQuery(session)}`,
      { headers: this.headers() },
      'getMeta',
    );
    return (await res.json()) as SessionMeta;
  }
}

export function isRemotePeerMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const transport = (env.SESSIONIO_TRANSPORT ?? 'filesystem').trim().toLowerCase();
  return transport === 'http' || transport === 'loopback';
}

export function createPeerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SessionioPeerClient | null {
  if (!isRemotePeerMode(env)) return null;
  const baseUrl = env.SESSIONIO_BASE_URL;
  if (!baseUrl) {
    throw new Error('SESSIONIO_BASE_URL is required when SESSIONIO_TRANSPORT is http/loopback');
  }
  return new SessionioPeerClient({
    baseUrl,
    token: env.SESSIONIO_HTTP_TOKEN,
  });
}
