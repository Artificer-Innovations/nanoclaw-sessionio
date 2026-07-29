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
  });

  it('detects remote peer mode', () => {
    expect(isRemotePeerMode({ SESSIONIO_TRANSPORT: 'filesystem' })).toBe(false);
    expect(isRemotePeerMode({ SESSIONIO_TRANSPORT: 'http' })).toBe(true);
    expect(isRemotePeerMode({ SESSIONIO_TRANSPORT: 'loopback' })).toBe(true);
  });

  it('createPeerFromEnv requires base URL in http mode', () => {
    expect(createPeerFromEnv({ SESSIONIO_TRANSPORT: 'filesystem' })).toBeNull();
    expect(() => createPeerFromEnv({ SESSIONIO_TRANSPORT: 'http' })).toThrow(/SESSIONIO_BASE_URL/);
  });

  it('registers peer from env', () => {
    process.env.SESSIONIO_TRANSPORT = 'loopback';
    process.env.SESSIONIO_BASE_URL = 'http://127.0.0.1:18765';
    registerSessionioRunner();
    expect(getSessionioPeer()).toBeInstanceOf(SessionioPeerClient);
  });

  it('peer client builds authorized requests', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new SessionioPeerClient({
      baseUrl: 'http://example.test',
      token: 'secret',
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }) as typeof fetch,
    });
    await client.pollInbound({ agentGroupId: 'ag', sessionId: 's1' });
    expect(calls[0]?.url).toContain('agentGroupId=ag');
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer secret',
    });
  });
});
