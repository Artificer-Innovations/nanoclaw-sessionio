import { describe, expect, it } from 'vitest';
import {
  patchContainerRunner,
  patchHostSweep,
  patchMessagesOut,
  patchPollLoop,
  patchRunnerIndex,
  uninstallContainerRunner,
  uninstallHostSweep,
  uninstallMessagesOut,
  uninstallPollLoop,
  uninstallRunnerIndex,
} from './patches.js';
import {
  STOCK_CONTAINER_RUNNER,
  STOCK_HOST_SWEEP,
  STOCK_MESSAGES_OUT,
  STOCK_POLL_LOOP,
  STOCK_RUNNER_INDEX,
} from './test-fixtures.js';

describe('remaining patches', () => {
  it('patches container-runner', () => {
    const patched = patchContainerRunner(STOCK_CONTAINER_RUNNER);
    expect(patched).toContain('syncSessionMeta');
    expect(patched).toContain('SESSIONIO_SESSION_ID');
    expect(patched).toContain('args.splice(insertAt');
    expect(uninstallContainerRunner(patched)).not.toContain(
      '@nanoclaw-sessionio:container-runner-meta:begin',
    );
  });

  it('patches runner index and poll-loop', () => {
    const runner = patchRunnerIndex(STOCK_RUNNER_INDEX);
    expect(runner).toContain('registerSessionioRunner');
    expect(uninstallRunnerIndex(runner)).not.toContain('@nanoclaw-sessionio:runner-register:begin');

    const poll = patchPollLoop(STOCK_POLL_LOOP);
    expect(poll).toContain('getSessionioPeer');
    expect(poll).toContain('sessionioPeer');
    expect(poll).toContain('sessionioGetPendingMessages');
    expect(poll).toContain('await sessionioGetPendingMessages(');
    expect(poll).toContain('await sessionioWriteMessageOut(');
    expect(patchPollLoop(poll)).toBe(poll);
    expect(uninstallPollLoop(poll)).not.toContain('@nanoclaw-sessionio:poll-loop-peer:begin');
  });

  it('patches messages-out peer bridge', () => {
    const patched = patchMessagesOut(STOCK_MESSAGES_OUT);
    expect(patched).toContain('postOutboundSync');
    expect(patched).toContain('getSessionioPeer()');
    expect(patched).toContain('return postOutboundSync(msg)');
    expect(patchMessagesOut(patched)).toBe(patched);
    expect(uninstallMessagesOut(patched)).not.toContain(
      '@nanoclaw-sessionio:messages-out-peer:begin',
    );
  });

  it('host-sweep uninstall restores heartbeat helper', () => {
    const patched = patchHostSweep(STOCK_HOST_SWEEP);
    expect(patched).toContain('countDueInbound');
    const restored = uninstallHostSweep(patched);
    expect(restored).toContain('function heartbeatMtimeMs');
    expect(restored).toContain('const dueCount = countDueMessages(inDb);');
  });
});
