import { describe, expect, it } from 'vitest';
import { buildOutboundSyncCurlArgs, buildOutboxSyncCurlArgs, clearedProxyEnv } from './outbound-sync.js';
import { inboundWireToRow, sessionRefFromEnv, writeToOutboundWire } from './mailbox.js';

describe('outbound-sync (MCP writeMessageOut → HTTP)', () => {
  it('builds curl argv with auth and outbound URL before body', () => {
    const args = buildOutboundSyncCurlArgs({
      baseUrl: 'http://host.docker.internal:18765/',
      agentGroupId: 'ag',
      sessionId: 's1',
      token: 'secret',
      body: '{"id":"o1"}',
    });
    expect(args[0]).toBe('curl');
    expect(args).toContain('--connect-timeout');
    expect(args).toContain('5');
    expect(args).toContain('--max-time');
    expect(args).toContain('15');
    expect(args).toContain('Authorization: Bearer secret');
    const url = args.at(-1)!;
    expect(url).toContain('/outbound?agentGroupId=ag');
    expect(url).toContain('sessionId=s1');
    expect(url).not.toMatch(/\/$/);
    expect(args.at(-2)).toBe('{"id":"o1"}');
  });

  it('requires base URL', () => {
    expect(() =>
      buildOutboundSyncCurlArgs({
        baseUrl: '',
        agentGroupId: 'a',
        sessionId: 's',
        body: '{}',
      }),
    ).toThrow(/SESSIONIO_BASE_URL/);
  });

  it('builds curl argv for /outbox staging before outbound', () => {
    const args = buildOutboxSyncCurlArgs({
      baseUrl: 'http://host:18765',
      agentGroupId: 'ag',
      sessionId: 's1',
      body: '{"messageId":"m1","files":[]}',
    });
    expect(args.at(-1)).toContain('/outbox?agentGroupId=ag');
    expect(args.at(-1)).toContain('sessionId=s1');
  });

  it('clears proxy env so OneCLI cannot swallow mailbox POSTs', () => {
    const cleared = clearedProxyEnv({
      HTTP_PROXY: 'http://proxy:8080',
      PATH: '/usr/bin',
    });
    expect(cleared.HTTP_PROXY).toBe('');
    expect(cleared.HTTPS_PROXY).toBe('');
    expect(cleared.http_proxy).toBe('');
    expect(cleared.PATH).toBe('/usr/bin');
  });
});

describe('mailbox sessionRefFromEnv', () => {
  it('requires session and agent group in http mode', () => {
    expect(() => sessionRefFromEnv({}, '')).toThrow(/SESSIONIO_SESSION_ID/);
    expect(() => sessionRefFromEnv({ SESSIONIO_SESSION_ID: 's' }, '')).toThrow(
      /SESSIONIO_AGENT_GROUP_ID/,
    );
    expect(
      sessionRefFromEnv({ SESSIONIO_SESSION_ID: 's', SESSIONIO_AGENT_GROUP_ID: 'ag' }),
    ).toEqual({ sessionId: 's', agentGroupId: 'ag' });
  });

  it('maps inbound wire to pending row', () => {
    const row = inboundWireToRow({
      id: 'in1',
      kind: 'chat',
      timestamp: '2026-01-01T00:00:00.000Z',
      content: '{"text":"hi"}',
      processAfter: null,
      platformId: 'p',
      channelType: 'web',
      threadId: null,
    });
    expect(row.id).toBe('in1');
    expect(row.status).toBe('pending');
    expect(row.platform_id).toBe('p');
    expect(row.trigger).toBe(1);

    const withTrigger = inboundWireToRow({
      id: 'in2',
      kind: 'chat',
      timestamp: '2026-01-01T00:00:00.000Z',
      content: '{}',
      recurrence: 'daily',
      trigger: 0,
    });
    expect(withTrigger.trigger).toBe(0);
    expect(withTrigger.recurrence).toBe('daily');
    expect(withTrigger.process_after).toBeNull();
  });

  it('maps write payload to outbound wire with optional fields', () => {
    const minimal = writeToOutboundWire({
      id: '1',
      kind: 'chat',
      content: '{"text":"hi"}',
    });
    expect(minimal.in_reply_to).toBeNull();
    expect(minimal.deliver_after).toBeNull();
    expect(minimal.recurrence).toBeNull();
    expect(minimal.platform_id).toBeNull();
    expect(minimal.channel_type).toBeNull();
    expect(minimal.thread_id).toBeNull();

    const wire = writeToOutboundWire({
      id: '1',
      kind: 'chat',
      content: '{"text":"hi"}',
      in_reply_to: 'in1',
      deliver_after: 'later',
      recurrence: 'weekly',
      platform_id: 'p',
      channel_type: 'web',
      thread_id: 't',
    });
    expect(wire.in_reply_to).toBe('in1');
    expect(wire.deliver_after).toBe('later');
    expect(wire.platform_id).toBe('p');
  });
});
