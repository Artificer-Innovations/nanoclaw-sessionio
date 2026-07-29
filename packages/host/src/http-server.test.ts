import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { HostMailboxStore } from './transports.js';
import {
  boundPortFromAddress,
  buildRequestUrl,
  createSessionioHttpServer,
  requestHost,
  requestPathname,
  resolveListenHost,
  resolveListenPort,
  startSessionioHttpServer,
} from './http-server.js';
import type { Server } from 'node:http';

const session = { agentGroupId: 'ag', sessionId: 's1' };
const qs = `agentGroupId=${session.agentGroupId}&sessionId=${session.sessionId}`;

describe('sessionio http server routes', () => {
  let server: Server;
  let baseUrl: string;
  let store: HostMailboxStore;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  async function start(opts: { token?: string } = {}) {
    store = new HostMailboxStore();
    const started = await startSessionioHttpServer({
      host: '127.0.0.1',
      port: 0,
      store,
      token: opts.token,
    });
    server = started.server;
    baseUrl = started.baseUrl;
  }

  it('covers health, mailbox queues, acks, heartbeat, inbox/outbox, meta, 404, and 400', async () => {
    await start();

    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);

    // Missing session params → 400
    expect((await fetch(`${baseUrl}/inbound`)).status).toBe(400);

    await fetch(`${baseUrl}/inbound?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'in1',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: '{}',
        processAfter: new Date(Date.now() + 60_000).toISOString(),
        onWake: 1,
      }),
    });
    await fetch(`${baseUrl}/inbound?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'in2',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: '{}',
      }),
    });

    // Non-first poll skips onWake; processAfter filters future messages.
    const skipped = (await (await fetch(`${baseUrl}/inbound?${qs}`)).json()) as {
      messages: unknown[];
    };
    expect(skipped.messages).toHaveLength(1);

    // First poll can take onWake once processAfter is not blocking — enqueue ready onWake.
    store.enqueueInbound(session, {
      id: 'wake',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: '{}',
      onWake: 1,
    });
    const first = (await (
      await fetch(`${baseUrl}/inbound?${qs}&isFirstPoll=1&limit=NaN`)
    ).json()) as { messages: Array<{ id: string }> };
    expect(first.messages.map((m) => m.id)).toContain('wake');

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
        content: '{}',
        in_reply_to: null,
      }),
    });
    expect(
      ((await (await fetch(`${baseUrl}/outbound?${qs}`)).json()) as { messages: unknown[] })
        .messages,
    ).toHaveLength(1);
    await fetch(`${baseUrl}/outbound/ack?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    await fetch(`${baseUrl}/outbound/ack?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageIds: ['out1'] }),
    });

    await fetch(`${baseUrl}/acks?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        acks: [{ message_id: 'in2', status: 'processing', claimed_at: new Date().toISOString() }],
      }),
    });
    await fetch(`${baseUrl}/acks?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(
      ((await (await fetch(`${baseUrl}/acks?${qs}`)).json()) as { acks: unknown[] }).acks.length,
    ).toBeGreaterThan(0);

    await fetch(`${baseUrl}/heartbeat?${qs}`, { method: 'POST' });
    const live = (await (await fetch(`${baseUrl}/liveness?${qs}`)).json()) as {
      lastHeartbeatAt: number;
    };
    expect(live.lastHeartbeatAt).toBeGreaterThan(0);

    await fetch(`${baseUrl}/inbox?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'in2', files: [{ name: 'a.txt', data: 'x' }] }),
    });
    await fetch(`${baseUrl}/inbox?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'in3' }),
    });
    expect(
      (
        (await (await fetch(`${baseUrl}/inbox?${qs}&messageId=in2`)).json()) as {
          files: unknown[];
        }
      ).files,
    ).toHaveLength(1);
    expect(
      ((await (await fetch(`${baseUrl}/inbox?${qs}`)).json()) as { files: unknown[] }).files,
    ).toEqual([]);

    await fetch(`${baseUrl}/outbox?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'out1', files: [{ name: 'b.txt' }] }),
    });
    await fetch(`${baseUrl}/outbox?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'out2' }),
    });
    expect(
      (
        (await (await fetch(`${baseUrl}/outbox?${qs}&messageId=out1`)).json()) as {
          files: unknown[];
        }
      ).files,
    ).toHaveLength(1);
    expect(
      ((await (await fetch(`${baseUrl}/outbox?${qs}`)).json()) as { files: unknown[] }).files,
    ).toEqual([]);

    await fetch(`${baseUrl}/meta?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        routing: { channel_type: 'web', platform_id: null, thread_id: null },
      }),
    });
    expect(
      (
        (await (await fetch(`${baseUrl}/meta?${qs}`)).json()) as {
          routing: { channel_type: string };
        }
      ).routing.channel_type,
    ).toBe('web');

    expect((await fetch(`${baseUrl}/nope?${qs}`)).status).toBe(404);

    // Invalid JSON body → 400
    expect(
      (
        await fetch(`${baseUrl}/inbound?${qs}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{',
        })
      ).status,
    ).toBe(400);
  });

  it('uses env token and global store defaults', async () => {
    process.env.SESSIONIO_HTTP_TOKEN = 'env-secret';
    const bare = createSessionioHttpServer();
    const started = await new Promise<{ server: Server; port: number }>((resolve, reject) => {
      bare.listen(0, '127.0.0.1', () => {
        const address = bare.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolve({ server: bare, port });
      });
      bare.once('error', reject);
    });
    server = started.server;
    baseUrl = `http://127.0.0.1:${started.port}`;
    expect((await fetch(`${baseUrl}/health`)).status).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/health`, {
          headers: { authorization: 'Bearer env-secret' },
        })
      ).status,
    ).toBe(200);
    delete process.env.SESSIONIO_HTTP_TOKEN;
  });

  it('startSessionioHttpServer reads host/port from env when unset', async () => {
    process.env.SESSIONIO_HTTP_HOST = '127.0.0.1';
    process.env.SESSIONIO_HTTP_PORT = '0';
    const started = await startSessionioHttpServer({ store: new HostMailboxStore() });
    server = started.server;
    baseUrl = started.baseUrl;
    expect(started.port).toBeGreaterThan(0);
    delete process.env.SESSIONIO_HTTP_HOST;
    delete process.env.SESSIONIO_HTTP_PORT;
  });

  it('covers defaults, empty meta, string errors, and raw request edge cases', async () => {
    expect(boundPortFromAddress(null, 9)).toBe(9);
    expect(boundPortFromAddress('\\\\.\\pipe\\x', 9)).toBe(9);
    expect(boundPortFromAddress({ port: 55 }, 9)).toBe(55);
    expect(resolveListenHost('0.0.0.0')).toBe('0.0.0.0');
    expect(resolveListenHost(undefined, '10.0.0.1')).toBe('10.0.0.1');
    expect(resolveListenHost(undefined, undefined)).toBe('127.0.0.1');
    expect(resolveListenPort(0)).toBe(0);
    expect(resolveListenPort(undefined, '9')).toBe(9);
    expect(resolveListenPort(undefined, undefined)).toBe(18765);
    expect(requestHost(undefined)).toBe('127.0.0.1');
    expect(requestHost('')).toBe('127.0.0.1');
    expect(requestHost(['a.example', 'b.example'])).toBe('a.example');
    expect(requestHost('ok.example')).toBe('ok.example');
    expect(requestPathname(undefined)).toBe('/');
    expect(requestPathname('/')).toBe('/');
    expect(requestPathname('////')).toBe('/');
    expect(requestPathname('?only-query')).toBe('/');
    expect(requestPathname('/inbound')).toBe('/inbound');
    expect(requestPathname('/inbound?x=1')).toBe('/inbound');
    expect(buildRequestUrl(undefined, '127.0.0.1').pathname).toBe('/');
    expect(buildRequestUrl('/inbound?x=1', 'h').searchParams.get('x')).toBe('1');

    delete process.env.SESSIONIO_HTTP_TOKEN;
    delete process.env.SESSIONIO_HTTP_HOST;
    delete process.env.SESSIONIO_HTTP_PORT;
    const started = await startSessionioHttpServer({
      host: '127.0.0.1',
      port: 0,
      store: new HostMailboxStore(),
    });
    server = started.server;
    baseUrl = started.baseUrl;

    // Empty meta → {}
    expect(await (await fetch(`${baseUrl}/meta?${qs}`)).json()).toEqual({});

    // Non-Error throw from store → String(error) branch
    const throwing = new HostMailboxStore();
    throwing.touchHeartbeat = () => {
      throw 'heartbeat-boom';
    };
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    const started2 = await startSessionioHttpServer({
      host: '127.0.0.1',
      port: 0,
      store: throwing,
    });
    server = started2.server;
    baseUrl = started2.baseUrl;
    const bad = await fetch(`${baseUrl}/heartbeat?${qs}`, { method: 'POST' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'heartbeat-boom' });

    // Missing Host / odd path via raw http
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: started2.port,
          path: '////',
          method: 'GET',
          headers: { Host: '' },
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            expect([200, 400, 401, 404]).toContain(res.statusCode);
            resolve();
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  });
});
