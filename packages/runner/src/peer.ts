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
}

function sessionQuery(session: SessionRef): string {
  return `agentGroupId=${encodeURIComponent(session.agentGroupId)}&sessionId=${encodeURIComponent(session.sessionId)}`;
}

export class SessionioPeerClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SessionioPeerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(json = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (json) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
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
    const res = await this.fetchImpl(`${this.baseUrl}/inbound?${params}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`pollInbound failed: ${res.status}`);
    const body = (await res.json()) as { messages: InboundMessage[] };
    return body.messages ?? [];
  }

  async postOutbound(session: SessionRef, message: OutboundMessage): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/outbound?${sessionQuery(session)}`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(message),
    });
    if (!res.ok && res.status !== 204) throw new Error(`postOutbound failed: ${res.status}`);
  }

  async heartbeat(session: SessionRef): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/heartbeat?${sessionQuery(session)}`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 204) throw new Error(`heartbeat failed: ${res.status}`);
  }

  async postAcks(session: SessionRef, acks: ProcessingAck[]): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/acks?${sessionQuery(session)}`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ acks }),
    });
    if (!res.ok && res.status !== 204) throw new Error(`postAcks failed: ${res.status}`);
  }

  async stageOutbox(
    session: SessionRef,
    messageId: string,
    files: Array<{ name: string; data?: string }>,
  ): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/outbox?${sessionQuery(session)}`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ messageId, files }),
    });
    if (!res.ok && res.status !== 204) throw new Error(`stageOutbox failed: ${res.status}`);
  }

  async getMeta(session: SessionRef): Promise<SessionMeta> {
    const res = await this.fetchImpl(`${this.baseUrl}/meta?${sessionQuery(session)}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`getMeta failed: ${res.status}`);
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
