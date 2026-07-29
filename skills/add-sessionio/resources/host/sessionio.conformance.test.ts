/**
 * Conformance: filesystem heartbeat + open-write-close style helpers.
 * Copied into the NanoClaw fork so `pnpm test` can pick it up after install.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  filesystemHeartbeatLiveness,
  touchHeartbeatFile,
  HostMailboxStore,
  createHttpTransport,
} from './transports.js';

describe('sessionio filesystem conformance', () => {
  it('heartbeat mtime advances with touch (DELETE-journal era liveness)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionio-conform-'));
    const hb = path.join(dir, '.heartbeat');
    expect(filesystemHeartbeatLiveness(hb).lastHeartbeatAt).toBe(0);
    touchHeartbeatFile(hb);
    const first = filesystemHeartbeatLiveness(hb).lastHeartbeatAt;
    expect(first).toBeGreaterThan(0);
    // ensure file exists and is a regular file (not a symlink)
    expect(fs.lstatSync(hb).isFile()).toBe(true);
  });
});

describe('sessionio http store conformance', () => {
  it('ack removes messages from pollOutbound', async () => {
    const store = new HostMailboxStore();
    const transport = createHttpTransport(store);
    const session = { agentGroupId: 'ag', sessionId: 's' };
    store.enqueueOutbound(session, {
      id: 'o1',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platform_id: null,
      channel_type: 'web',
      thread_id: null,
      content: '{"text":"x"}',
      in_reply_to: null,
    });
    expect(await transport.pollOutbound(session)).toHaveLength(1);
    await transport.ackDelivered(session, ['o1']);
    expect(await transport.pollOutbound(session)).toHaveLength(0);
  });
});
