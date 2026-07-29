import { describe, expect, it, beforeEach } from 'vitest';
import { SessionioPeerClient, createPeerFromEnv, isRemotePeerMode } from './peer.js';
import {
  getSessionioPeer,
  registerSessionioRunner,
  resetSessionioRunnerForTests,
} from './register.js';

describe('runner peer', () => {
  beforeEach(() => {
    resetSessionioRunnerForTests();
    delete process.env.SESSIONIO_TRANSPORT;
    delete process.env.SESSIONIO_BASE_URL;
    delete process.env.SESSIONIO_HTTP_TOKEN;
  });

  it('detects remote peer mode', () => {
    expect(isRemotePeerMode({ SESSIONIO_TRANSPORT: 'filesystem' })).toBe(false);
    expect(isRemotePeerMode({ SESSIONIO_TRANSPORT: 'http' })).toBe(true);
    expect(isRemotePeerMode({ SESSIONIO_TRANSPORT: 'loopback' })).toBe(true);
    expect(isRemotePeerMode({})).toBe(false);
  });

  it('createPeerFromEnv requires base URL in http mode', () => {
    expect(createPeerFromEnv({ SESSIONIO_TRANSPORT: 'filesystem' })).toBeNull();
    expect(() => createPeerFromEnv({ SESSIONIO_TRANSPORT: 'http' })).toThrow(/SESSIONIO_BASE_URL/);
    expect(
      createPeerFromEnv({
        SESSIONIO_TRANSPORT: 'http',
        SESSIONIO_BASE_URL: 'http://x/',
        SESSIONIO_HTTP_TOKEN: 't',
      }),
    ).toBeInstanceOf(SessionioPeerClient);
  });

  it('registers peer from env', () => {
    process.env.SESSIONIO_TRANSPORT = 'loopback';
    process.env.SESSIONIO_BASE_URL = 'http://127.0.0.1:18765';
    registerSessionioRunner();
    expect(getSessionioPeer()).toBeInstanceOf(SessionioPeerClient);
  });

  it('eager module-scope capture is null before register (ESM hoist regression)', () => {
    process.env.SESSIONIO_TRANSPORT = 'loopback';
    process.env.SESSIONIO_BASE_URL = 'http://127.0.0.1:18765';
    const eagerCapture = getSessionioPeer();
    expect(eagerCapture).toBeNull();
    registerSessionioRunner();
    expect(getSessionioPeer()).not.toBeNull();
    expect(eagerCapture).toBeNull();
  });

  it('peer client builds authorized requests with poll options', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new SessionioPeerClient({
      baseUrl: 'http://example.test/',
      token: 'secret',
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({}), { status: 200 });
      }) as typeof fetch,
    });
    const messages = await client.pollInbound(
      { agentGroupId: 'ag', sessionId: 's1' },
      { limit: 2, isFirstPoll: true },
    );
    expect(messages).toEqual([]);
    expect(calls[0]?.url).toContain('limit=2');
    expect(calls[0]?.url).toContain('isFirstPoll=1');
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer secret',
    });
  });

  it('peer client round-trips outbound/acks/heartbeat/outbox/meta via fetch', async () => {
    const calls: string[] = [];
    const client = new SessionioPeerClient({
      baseUrl: 'http://mailbox.test',
      token: 't',
      fetchImpl: (async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
        if (String(url).includes('/meta')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const session = { agentGroupId: 'ag', sessionId: 's1' };
    await client.postOutbound(session, {
      id: 'o1',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platform_id: null,
      channel_type: 'web',
      thread_id: null,
      content: '{}',
      in_reply_to: null,
    });
    await client.postAcks(session, [
      { message_id: 'i1', status: 'processing', claimed_at: new Date().toISOString() },
    ]);
    await client.heartbeat(session);
    await client.stageOutbox(session, 'o1', [{ name: 'a.txt', data: 'x' }]);
    await client.getMeta(session);
    expect(calls.some((c) => c.includes('/outbound'))).toBe(true);
    expect(calls.some((c) => c.includes('/acks'))).toBe(true);
    expect(calls.some((c) => c.includes('/heartbeat'))).toBe(true);
    expect(calls.some((c) => c.includes('/outbox'))).toBe(true);
    expect(calls.some((c) => c.includes('/meta'))).toBe(true);
  });

  it('peer client accepts 200 on mutating routes and surfaces errors', async () => {
    const okClient = new SessionioPeerClient({
      baseUrl: 'http://mailbox.test',
      fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    });
    const session = { agentGroupId: 'ag', sessionId: 's1' };
    await okClient.postOutbound(session, {
      id: 'o1',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platform_id: null,
      channel_type: null,
      thread_id: null,
      content: '{}',
      in_reply_to: null,
    });
    await okClient.heartbeat(session);
    await okClient.postAcks(session, []);
    await okClient.stageOutbox(session, 'o1', []);

    const bad = new SessionioPeerClient({
      baseUrl: 'http://mailbox.test',
      fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
    });
    await expect(bad.pollInbound(session)).rejects.toThrow(/pollInbound failed/);
    await expect(
      bad.postOutbound(session, {
        id: 'o1',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platform_id: null,
        channel_type: null,
        thread_id: null,
        content: '{}',
        in_reply_to: null,
      }),
    ).rejects.toThrow(/postOutbound failed/);
    await expect(bad.heartbeat(session)).rejects.toThrow(/heartbeat failed/);
    await expect(bad.postAcks(session, [])).rejects.toThrow(/postAcks failed/);
    await expect(bad.stageOutbox(session, 'o1', [])).rejects.toThrow(/stageOutbox failed/);
    await expect(bad.getMeta(session)).rejects.toThrow(/getMeta failed/);
  });
});
