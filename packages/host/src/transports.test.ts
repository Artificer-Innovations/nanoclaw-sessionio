import { describe, expect, it } from 'vitest';
import {
  HostMailboxStore,
  createFilesystemTransport,
  createHttpTransport,
  globalHostMailboxStore,
} from './transports.js';
import { warnOnce, resetWarnOnceForTests } from './warn-once.js';

describe('HostMailboxStore', () => {
  it('covers inbound filters, outbound ack, acks merge, attachments, meta, clear', () => {
    const store = new HostMailboxStore();
    const session = { agentGroupId: 'ag', sessionId: 's' };
    const future = new Date(Date.now() + 60_000).toISOString();

    store.enqueueInbound(session, {
      id: 'future',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: '{}',
      processAfter: future,
    });
    store.enqueueInbound(session, {
      id: 'wake',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: '{}',
      onWake: 1,
    });
    store.enqueueInbound(session, {
      id: 'ready',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: '{}',
    });

    expect(store.listInbound(session)).toHaveLength(3);
    expect(store.countDueInbound(session)).toBe(2);
    expect(store.takeInbound(session, { limit: 0 })).toEqual([]);
    expect(store.takeInbound(session).map((m) => m.id)).toEqual(['ready']);
    expect(store.takeInbound(session, { isFirstPoll: true }).map((m) => m.id)).toEqual(['wake']);
    expect(store.countDueInbound(session)).toBe(0); // only processAfter-future left
    expect(store.listInbound(session).map((m) => m.id)).toEqual(['future']);
    store.enqueueInbound(session, {
      id: 'past',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: '{}',
      processAfter: new Date(Date.now() - 1000).toISOString(),
    });
    store.enqueueInbound(session, {
      id: 'plain',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: '{}',
    });
    expect(store.countDueInbound(session)).toBe(2);

    store.enqueueOutbound(session, {
      id: 'o1',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platform_id: null,
      channel_type: null,
      thread_id: null,
      content: '{}',
      in_reply_to: null,
    });
    expect(store.pollOutbound(session)).toHaveLength(1);
    store.ackDelivered(session, ['o1']);
    expect(store.pollOutbound(session)).toHaveLength(0);

    store.setProcessingAcks(session, [{ message_id: 'a', status: 'processing', claimed_at: 't1' }]);
    store.setProcessingAcks(session, [
      { message_id: 'a', status: 'completed', claimed_at: 't2' },
      { message_id: 'b', status: 'processing', claimed_at: 't3' },
    ]);
    expect(store.getProcessingAcks(session)).toHaveLength(2);

    store.touchHeartbeat(session, 42);
    expect(store.getLiveness(session)).toEqual({ lastHeartbeatAt: 42 });
    expect(store.getLiveness({ agentGroupId: 'x', sessionId: 'y' })).toEqual({
      lastHeartbeatAt: 0,
    });

    store.stageInbox(session, 'm1', [{ name: 'i.txt', data: '1' }]);
    expect(store.getInbox(session, 'm1')).toEqual([{ name: 'i.txt', data: '1' }]);
    expect(store.getInbox(session, 'missing')).toEqual([]);

    store.stageOutbox(session, 'm1', [{ name: 'o.txt' }]);
    expect(store.consumeOutbox(session, 'm1')).toEqual([{ name: 'o.txt' }]);
    expect(store.consumeOutbox(session, 'm1')).toEqual([]);

    store.syncSessionMeta(session, {
      routing: { channel_type: 'web', platform_id: null, thread_id: null },
    });
    expect(store.getSessionMeta(session)).toEqual({
      routing: { channel_type: 'web', platform_id: null, thread_id: null },
    });
    expect(store.getSessionMeta({ agentGroupId: 'z', sessionId: 'z' })).toBeUndefined();

    store.clear();
    expect(store.listInbound(session)).toEqual([]);
    expect(store.takeInbound({ agentGroupId: 'none', sessionId: 'none' })).toEqual([]);
    expect(store.countDueInbound({ agentGroupId: 'none', sessionId: 'none' })).toBe(0);
  });

  it('createHttpTransport delegates every SessionTransport method', async () => {
    const store = new HostMailboxStore();
    const transport = createHttpTransport(store);
    const session = { agentGroupId: 'ag', sessionId: 's' };
    transport.enqueueInbound(session, {
      id: '1',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: '{}',
    });
    expect(transport.countDueInbound?.(session)).toBe(1);
    await transport.ackDelivered(session, []);
    expect(transport.getProcessingAcks(session)).toEqual([]);
    expect((await transport.getLiveness(session)).lastHeartbeatAt).toBe(0);
    transport.stageInbox?.(session, '1', [{ name: 'a' }]);
    expect(await transport.consumeOutbox(session, '1')).toEqual([]);
    transport.syncSessionMeta?.(session, {});
    expect(transport.pollOutbound(session)).toEqual([]);
    expect(globalHostMailboxStore).toBeInstanceOf(HostMailboxStore);
  });

  it('createFilesystemTransport optional clearOutbox and countDueInbound', async () => {
    const calls: string[] = [];
    const transport = createFilesystemTransport({
      ensureSessionFolder: () => calls.push('ensure'),
      enqueueInbound: () => calls.push('enqueue'),
      pollOutbound: () => [],
      ackDelivered: () => calls.push('ack'),
      getProcessingAcks: () => [],
      getLiveness: () => ({ lastHeartbeatAt: 0 }),
      stageInbox: () => calls.push('inbox'),
      consumeOutbox: () => [{ name: 'f' }],
      clearOutbox: () => calls.push('clear'),
      syncSessionMeta: () => calls.push('meta'),
      countDueInbound: () => 3,
    });
    const session = { agentGroupId: 'a', sessionId: 's' };
    transport.enqueueInbound(session, {
      id: '1',
      kind: 'chat',
      timestamp: '',
      content: '{}',
    });
    transport.stageInbox?.(session, '1', []);
    expect(await transport.consumeOutbox(session, '1')).toEqual([{ name: 'f' }]);
    transport.syncSessionMeta?.(session, {});
    expect(transport.countDueInbound?.(session)).toBe(3);
    expect(transport.pollOutbound(session)).toEqual([]);
    await transport.ackDelivered(session, ['1'], [null]);
    expect(transport.getProcessingAcks(session)).toEqual([]);
    expect(transport.getLiveness(session)).toEqual({ lastHeartbeatAt: 0 });
    expect(calls).toEqual(['ensure', 'enqueue', 'inbox', 'clear', 'meta', 'ack']);

    const bare = createFilesystemTransport({
      ensureSessionFolder: () => undefined,
      enqueueInbound: () => undefined,
      pollOutbound: () => [],
      ackDelivered: () => undefined,
      getProcessingAcks: () => [],
      getLiveness: () => ({ lastHeartbeatAt: 0 }),
      stageInbox: () => undefined,
      consumeOutbox: () => [],
    });
    expect(bare.countDueInbound?.(session)).toBe(0);
    bare.syncSessionMeta?.(session, {});
    expect(await bare.consumeOutbox(session, 'x')).toEqual([]);
  });
});

describe('warnOnce', () => {
  it('logs with and without error, once per key', () => {
    resetWarnOnceForTests();
    warnOnce('k', 'hello');
    warnOnce('k', 'hello again');
    warnOnce('k2', 'with err', new Error('boom'));
  });
});
