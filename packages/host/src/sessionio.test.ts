import { describe, expect, it, beforeEach } from 'vitest';
import {
  getSessionioCapabilities,
  listRegisteredTransports,
  probeSessionioCapabilities,
  registerSessionTransport,
  resetSessionioForTests,
  resolveSessionTransport,
  resolveTransportName,
  setDefaultSessionTransport,
  setSessionTransportResolver,
  warnIllegalTransportRuntimePair,
  warnOnce,
} from './sessionio.js';
import {
  HostMailboxStore,
  createFilesystemTransport,
  createHttpTransport,
  filesystemHeartbeatLiveness,
  touchHeartbeatFile,
} from './transports.js';
import { startSessionioHttpServer } from './http-server.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('sessionio registry', () => {
  beforeEach(() => {
    resetSessionioForTests();
    delete process.env.SESSIONIO_TRANSPORT;
  });

  it('registers and resolves transports', () => {
    const store = new HostMailboxStore();
    registerSessionTransport('filesystem', createHttpTransport(store));
    const t = resolveSessionTransport({ agentGroupId: 'a', sessionId: 's' });
    t.enqueueInbound(
      { agentGroupId: 'a', sessionId: 's' },
      {
        id: '1',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: '{"text":"hi"}',
      },
    );
    expect(store.listInbound({ agentGroupId: 'a', sessionId: 's' })).toHaveLength(1);
  });

  it('normalizes loopback to http and honors env', () => {
    const store = new HostMailboxStore();
    registerSessionTransport('http', createHttpTransport(store));
    process.env.SESSIONIO_TRANSPORT = 'loopback';
    expect(resolveTransportName({ agentGroupId: 'a', sessionId: 's' })).toBe('http');
  });

  it('exposes capabilities and probe', () => {
    registerSessionTransport('filesystem', createHttpTransport(new HostMailboxStore()));
    const caps = getSessionioCapabilities();
    expect(caps.apiVersion).toBe(1);
    expect(caps.features.filesystem).toBe(true);
    expect(probeSessionioCapabilities(() => caps).present).toBe(true);
    expect(
      probeSessionioCapabilities(() => {
        throw new Error('missing');
      }).present,
    ).toBe(false);
  });

  it('warns on illegal filesystem+fly pairing', () => {
    warnIllegalTransportRuntimePair('filesystem', 'fly');
    warnIllegalTransportRuntimePair('filesystem', 'fly');
  });

  it('setDefaultSessionTransport changes resolve', () => {
    const store = new HostMailboxStore();
    registerSessionTransport('http', createHttpTransport(store));
    setDefaultSessionTransport('http');
    expect(resolveTransportName({ agentGroupId: 'a', sessionId: 's' })).toBe('http');
  });

  it('honors session transportName, resolver override, unregister, and errors', () => {
    const store = new HostMailboxStore();
    const unregister = registerSessionTransport('http', createHttpTransport(store));
    expect(
      resolveTransportName({ agentGroupId: 'a', sessionId: 's', transportName: 'loopback' }),
    ).toBe('http');
    setSessionTransportResolver(() => 'http');
    expect(resolveTransportName({ agentGroupId: 'a', sessionId: 's' })).toBe('http');
    setSessionTransportResolver(() => undefined);
    expect(resolveTransportName({ agentGroupId: 'a', sessionId: 's' })).toBe('filesystem');
    setSessionTransportResolver(null);
    expect(listRegisteredTransports()).toContain('http');
    unregister();
    expect(() => resolveSessionTransport({ agentGroupId: 'a', sessionId: 's' })).toThrow(
      /not registered/,
    );
    expect(() => registerSessionTransport('  ', createHttpTransport(store))).toThrow(/empty/);
    expect(() => registerSessionTransport('x', null as never)).toThrow(/must be an object/);
    warnIllegalTransportRuntimePair('http', 'fly');
    warnOnce('reg', 'msg', 'err');
  });
});

describe('filesystem helpers', () => {
  it('touch and read heartbeat liveness', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionio-hb-'));
    const hb = path.join(dir, '.heartbeat');
    expect(filesystemHeartbeatLiveness(hb).lastHeartbeatAt).toBe(0);
    touchHeartbeatFile(hb);
    expect(filesystemHeartbeatLiveness(hb).lastHeartbeatAt).toBeGreaterThan(0);
  });

  it('createFilesystemTransport delegates', async () => {
    const calls: string[] = [];
    const transport = createFilesystemTransport({
      ensureSessionFolder: () => calls.push('ensure'),
      enqueueInbound: () => calls.push('enqueue'),
      pollOutbound: () => [],
      ackDelivered: () => calls.push('ack'),
      getProcessingAcks: () => [],
      getLiveness: () => ({ lastHeartbeatAt: 1 }),
      stageInbox: () => calls.push('stage'),
      consumeOutbox: () => [{ name: 'a.txt' }],
      clearOutbox: () => calls.push('clear'),
    });
    transport.enqueueInbound(
      { agentGroupId: 'a', sessionId: 's' },
      { id: '1', kind: 'chat', timestamp: '', content: '{}' },
    );
    await transport.ackDelivered({ agentGroupId: 'a', sessionId: 's' }, ['1']);
    const files = await transport.consumeOutbox({ agentGroupId: 'a', sessionId: 's' }, '1');
    expect(calls).toEqual(['ensure', 'enqueue', 'ack', 'clear']);
    expect(files[0]?.name).toBe('a.txt');
  });
});

describe('http mailbox', () => {
  it('round-trips inbound/outbound over loopback HTTP', async () => {
    const store = new HostMailboxStore();
    const { server, baseUrl } = await startSessionioHttpServer({
      host: '127.0.0.1',
      port: 0,
      store,
    });
    const session = { agentGroupId: 'ag', sessionId: 'sess' };
    const qs = `agentGroupId=${session.agentGroupId}&sessionId=${session.sessionId}`;

    await fetch(`${baseUrl}/inbound?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'in1',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: '{"text":"hello"}',
      }),
    });

    const inbound = (await (await fetch(`${baseUrl}/inbound?${qs}`)).json()) as {
      messages: unknown[];
    };
    expect(inbound.messages).toHaveLength(1);

    await fetch(`${baseUrl}/outbound?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'out1',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platform_id: null,
        channel_type: 'web',
        thread_id: null,
        content: '{"text":"hi"}',
        in_reply_to: 'in1',
      }),
    });

    const hostTransport = createHttpTransport(store);
    const outbound = await hostTransport.pollOutbound(session);
    expect(outbound).toHaveLength(1);
    await hostTransport.ackDelivered(session, ['out1']);
    expect(await hostTransport.pollOutbound(session)).toHaveLength(0);

    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('rejects unauthorized requests when token is configured', async () => {
    const store = new HostMailboxStore();
    const { server, baseUrl } = await startSessionioHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      store,
    });
    const qs = 'agentGroupId=ag&sessionId=s';
    const denied = await fetch(`${baseUrl}/inbound?${qs}`);
    expect(denied.status).toBe(401);

    const ok = await fetch(`${baseUrl}/health`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(ok.status).toBe(200);

    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('honors takeInbound limit (maxMessagesPerPrompt)', async () => {
    const store = new HostMailboxStore();
    const session = { agentGroupId: 'ag', sessionId: 's' };
    for (let i = 0; i < 5; i++) {
      store.enqueueInbound(session, {
        id: `m${i}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: '{}',
      });
    }
    const { server, baseUrl } = await startSessionioHttpServer({
      host: '127.0.0.1',
      port: 0,
      store,
    });
    const qs = 'agentGroupId=ag&sessionId=s&limit=2';
    const body = (await (await fetch(`${baseUrl}/inbound?${qs}`)).json()) as {
      messages: unknown[];
    };
    expect(body.messages).toHaveLength(2);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });
});
