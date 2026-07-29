import { describe, expect, it } from 'vitest';
import {
  patchContainerRunner,
  patchIndex,
  patchMessagesOut,
  patchPollLoop,
  patchRunnerIndex,
  patchSessionManager,
  uninstallContainerRunner,
  uninstallDelivery,
  uninstallIndex,
  uninstallMessagesOut,
  uninstallPollLoop,
  uninstallSessionManager,
} from './patches.js';
import {
  STOCK_CONTAINER_RUNNER,
  STOCK_INDEX,
  STOCK_MESSAGES_OUT,
  STOCK_POLL_LOOP,
  STOCK_SESSION_MANAGER,
} from './test-fixtures.js';

const SESSIONIO_MARKER = '@nanoclaw-sessionio';
const begin = (name: string) => `// ${SESSIONIO_MARKER}:${name}:begin`;
const end = (name: string) => `// ${SESSIONIO_MARKER}:${name}:end`;

/** Stale inline env inject (the bug: would append after image if splice used wrong index). */
function staleContainerRunnerEnvBlock(): string {
  return `${begin('container-runner-env')}
  if (resolveTransportName({ agentGroupId: agentGroup.id, sessionId: session.id }) === 'http') {
    // Intentionally broken: pushEnv appends at end (after image).
    const pushEnv = (key: string, value: string | undefined) => {
      if (!value) return;
      args.push('-e', \`\${key}=\${value}\`);
    };
    pushEnv('SESSIONIO_TRANSPORT', 'http');
    pushEnv('SESSIONIO_SESSION_ID', session.id);
  }
${end('container-runner-env')}
`;
}

const STOCK_POLL_LOOP_WITH_SYNC_HELPERS = `import { getPendingMessages, markProcessing, markCompleted, markScriptSkipped } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { touchHeartbeat } from './db/connection.js';

export async function runPollLoop(config: unknown): Promise<void> {
  void config;
  const messages = getPendingMessages(true).filter((m) => m.id);
  markProcessing(messages.map((m) => m.id));
  dispatchResultText('hi');
  sendToDestination('web');
  autoAppendTaskLog('done');
  deliverErrorResult('boom');
  writeMessageOut({ id: 'out-1', kind: 'chat', content: 'hi' });
  markCompleted(messages.map((m) => m.id));
  markScriptSkipped([]);
  touchHeartbeat();
}

function deliverErrorResult(err: string) {
  writeMessageOut({ id: 'err', kind: 'chat', content: err });
}

export function dispatchResultText(text: string) {
  writeMessageOut({ id: 'out', kind: 'chat', content: text });
}

export function autoAppendTaskLog(line: string) {
  writeMessageOut({ id: 'log', kind: 'chat', content: line });
}

function sendToDestination(dest: string) {
  writeMessageOut({ id: 'dest', kind: 'chat', content: dest });
}
`;

describe('remaining patches', () => {
  it('patches container-runner to call injectSessionioContainerEnv', () => {
    const patched = patchContainerRunner(STOCK_CONTAINER_RUNNER);
    expect(patched).toContain('injectSessionioContainerEnv');
    expect(patched).toContain("from './sessionio-docker-env.js'");
    expect(patched).toContain('syncSessionMeta');
    expect(patched).toContain('session_routing');
    expect(patched).not.toContain(
      'syncSessionMeta?.(\n      { agentGroupId: agentGroup.id, sessionId: session.id },\n      {},\n    )',
    );
    expect(uninstallContainerRunner(patched)).not.toContain(
      '@nanoclaw-sessionio:container-runner-meta:begin',
    );
    // Stock writeSessionRouting must survive uninstall (lives outside the marker).
    expect(uninstallContainerRunner(patched)).toContain(
      'writeSessionRouting(agentGroup.id, session.id);',
    );
  });

  it('restores missing spawn writeSessionRouting then installs meta', () => {
    const missing = STOCK_CONTAINER_RUNNER.replace(
      '  writeSessionRouting(agentGroup.id, session.id);\n\n',
      '',
    );
    expect(missing).not.toContain('writeSessionRouting(agentGroup.id, session.id);');
    const patched = patchContainerRunner(missing);
    expect(patched).toContain('writeSessionRouting(agentGroup.id, session.id);');
    expect(patched).toContain('@nanoclaw-sessionio:container-runner-meta:begin');
    expect(uninstallContainerRunner(patched)).toContain(
      'writeSessionRouting(agentGroup.id, session.id);',
    );
  });

  it('fills agenthosts wake-prepare-meta-slot with syncSessionMeta', () => {
    const patched = patchContainerRunner(STOCK_CONTAINER_RUNNER);
    expect(patched).toContain('@nanoclaw-sessionio:wake-prepare-meta:begin');
    expect(patched).toContain('agentGroupId: session.agent_group_id');
    expect(patched).toContain('sessionId: session.id');
    expect(patched).toMatch(
      /wake-prepare-meta:begin[\s\S]*syncSessionMeta\?\.\([\s\S]*wake-prepare-meta:end/,
    );
    expect(patched).not.toContain('wake-prepare-meta-slot');
    expect(patchContainerRunner(patched)).toBe(patched);

    const uninstalled = uninstallContainerRunner(patched);
    expect(uninstalled).toContain('// @nanoclaw-sessionio:wake-prepare-meta-slot');
    expect(uninstalled).not.toContain('@nanoclaw-sessionio:wake-prepare-meta:begin');
  });

  it('upgrades stale container-runner-meta that synced empty {}', () => {
    const good = patchContainerRunner(STOCK_CONTAINER_RUNNER);
    const stale = good.replace(
      /void transport\.syncSessionMeta\?\.\([\s\S]*?\n\s*\);/,
      `void transport.syncSessionMeta?.(
      { agentGroupId: agentGroup.id, sessionId: session.id },
      {},
    );`,
    );
    expect(stale).toContain('{},\n    );');
    const upgraded = patchContainerRunner(stale);
    expect(upgraded).toContain('session_routing');
    expect(upgraded).not.toContain('{},\n    );');
  });

  it('upgrades stale append-style container-runner env blocks', () => {
    const withStale = STOCK_CONTAINER_RUNNER.replace(
      "  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });",
      `${staleContainerRunnerEnvBlock()}
  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });`,
    );
    expect(withStale).toContain('args.push');
    expect(withStale).not.toContain('injectSessionioContainerEnv');

    const upgraded = patchContainerRunner(withStale);
    expect(upgraded).toContain('injectSessionioContainerEnv');
    expect(upgraded).not.toContain("args.push('-e'");
    expect(upgraded).toContain("from './sessionio-docker-env.js'");
  });

  it('patches runner index and poll-loop with lazy peer (not eager capture)', () => {
    const poll = patchPollLoop(STOCK_POLL_LOOP);
    expect(poll).toContain('function sessionioPeer()');
    expect(poll).toContain('return getSessionioPeer()');
    expect(poll).not.toContain('const __sessionioPeer = getSessionioPeer()');
    expect(poll).toContain('await sessionioGetPendingMessages(');
    expect(poll).toContain('await sessionioWriteMessageOut(');
    expect(poll).toContain('stageOutbox');
    expect(poll).toContain('getMeta');
    expect(patchPollLoop(poll)).toBe(poll);
    expect(uninstallPollLoop(poll)).not.toContain('@nanoclaw-sessionio:poll-loop-peer:begin');
  });

  it('upgrades stale poll-loop that eagerly captured the peer (ESM hoist bug)', () => {
    const good = patchPollLoop(STOCK_POLL_LOOP);
    const stale = good.replace(
      `function sessionioPeer() {
  return getSessionioPeer();
}`,
      `const __sessionioPeer = getSessionioPeer();
function sessionioPeer() {
  return __sessionioPeer;
}`,
    );
    expect(stale).toContain('const __sessionioPeer = getSessionioPeer()');
    const upgraded = patchPollLoop(stale);
    expect(upgraded).not.toContain('const __sessionioPeer = getSessionioPeer()');
    expect(upgraded).toContain('function sessionioPeer()');
    expect(upgraded).toContain('await sessionioGetPendingMessages(');
  });

  it('makes sync helpers async so await writeMessageOut does not crash', () => {
    const patched = patchPollLoop(STOCK_POLL_LOOP_WITH_SYNC_HELPERS);
    expect(patched).toContain('async function deliverErrorResult(');
    expect(patched).toContain('export async function dispatchResultText(');
    expect(patched).toContain('export async function autoAppendTaskLog(');
    expect(patched).toContain('async function sendToDestination(');
    expect(patched).toContain('await dispatchResultText(');
    expect(patched).toContain('await sendToDestination(');
    expect(patched).toContain('await autoAppendTaskLog(');
    expect(patched).toContain('await deliverErrorResult(');
    expect(patched).toContain('(await sessionioGetPendingMessages(');
    // Helpers must use the peer-aware write path, not raw SQLite.
    expect(patched).toMatch(
      /async function deliverErrorResult[\s\S]*await sessionioWriteMessageOut\(/,
    );
  });

  it('patches messages-out peer bridge through outbound-sync helpers', () => {
    const patched = patchMessagesOut(STOCK_MESSAGES_OUT);
    expect(patched).toContain('postOutboundSync');
    expect(patched).toContain('buildOutboundSyncCurlArgs');
    expect(patched).toContain('clearedProxyEnv');
    expect(patched).toContain('return postOutboundSync(msg)');
    expect(patchMessagesOut(patched)).toBe(patched);
    expect(uninstallMessagesOut(patched)).not.toContain(
      '@nanoclaw-sessionio:messages-out-peer:begin',
    );
  });

  it('restores spawn log when missing but buildContainerArgs close is present', () => {
    const withoutLog = `import { writeSessionRouting } from './session-manager.js';

export async function wakeContainer(agentGroup: { id: string; name: string }, session: { id: string }, containerName: string): Promise<void> {
  writeSessionRouting(agentGroup.id, session.id);

  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
  );
}
`;
    const patched = patchContainerRunner(withoutLog);
    expect(patched).toContain(
      "log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });",
    );
    expect(patched).toContain('injectSessionioContainerEnv');
  });

  it('upgrades marked messages-out that still inline curl argv', () => {
    const patched = patchMessagesOut(STOCK_MESSAGES_OUT);
    const stale = patched
      .replaceAll('buildOutboundSyncCurlArgs', 'legacyBuildCurl')
      .replaceAll('clearedProxyEnv', 'legacyClearProxy');
    expect(stale).toContain('@nanoclaw-sessionio:messages-out-peer:begin');
    expect(stale).not.toContain('buildOutboundSyncCurlArgs');
    const upgraded = patchMessagesOut(stale);
    expect(upgraded).toContain('buildOutboundSyncCurlArgs');
    expect(upgraded).toContain('clearedProxyEnv');
  });

  it('upgrades marked messages-out that posts without stageOutbox', () => {
    const patched = patchMessagesOut(STOCK_MESSAGES_OUT);
    expect(patched).toContain('stageOutbox');
    const stale = patched.replaceAll('stageOutbox', 'legacyStage');
    expect(stale).toContain('buildOutboundSyncCurlArgs');
    expect(stale).not.toContain('stageOutbox');
    const upgraded = patchMessagesOut(stale);
    expect(upgraded).toContain('stageOutbox');
  });

  it('leaves unmarked sandbox peer bridge alone when already using outbound-sync', () => {
    const unmarked = `import { getConfig } from '../config.js';

function postOutboundSync(msg: { id: string }): number {
  void buildOutboundSyncCurlArgs;
  void getSessionioPeer();
  return 0;
}

export function writeMessageOut(msg: { id: string }): number {
  return postOutboundSync(msg);
}
`;
    expect(patchMessagesOut(unmarked)).toBe(unmarked);
  });

  it('throws when messages-out / index anchors are missing', () => {
    expect(() => patchMessagesOut('export const nope = 1;\n')).toThrow(/import anchor/);
    expect(() => patchMessagesOut(`import x from 'y';\nexport function other() {}\n`)).toThrow(
      /writeMessageOut export anchor/,
    );
    expect(() =>
      patchMessagesOut(`import x from 'y';
export function writeMessageOut(msg: WriteMessageOut): number {
  return 1;
}
`),
    ).toThrow(/writeMessageOut body start anchor/);
    expect(() => patchIndex('async function main(): Promise<void> {}\n')).toThrow(
      /delivery poll boot anchor/,
    );
    expect(patchIndex(STOCK_INDEX)).toContain('startSessionio');
  });

  it('uninstallIndex preserves stock delivery poll starts', () => {
    const installed = patchIndex(STOCK_INDEX);
    expect(installed).toContain('@nanoclaw-sessionio:index-boot:begin');
    expect(installed).toContain('startSessionio');
    const restored = uninstallIndex(installed);
    expect(restored).not.toContain('@nanoclaw-sessionio:index-boot');
    expect(restored).not.toContain('startSessionio');
    expect(restored).toContain('startActiveDeliveryPoll();');
    expect(restored).toContain('startSweepDeliveryPoll();');
    expect(restored).toBe(STOCK_INDEX);
  });

  it('reinstalls session-manager after uninstall left extra blank lines', () => {
    const installed = patchSessionManager(STOCK_SESSION_MANAGER);
    const restored = uninstallSessionManager(installed);
    // Simulate older uninstall that left an extra blank before the docblock.
    const dirty = restored.replace(
      /updateSession\(sessionId, \{ last_active: new Date\(\)\.toISOString\(\) \}\);\n\}\n\n\/\*\*/,
      'updateSession(sessionId, { last_active: new Date().toISOString() });\n}\n\n\n/**',
    );
    expect(dirty).not.toBe(restored);
    const reinstalled = patchSessionManager(dirty);
    expect(reinstalled).toContain('filesystemWriteSessionMessage');
    expect(reinstalled).toContain('@nanoclaw-sessionio:session-manager-write:begin');
    expect(uninstallSessionManager(reinstalled)).toContain(
      'export function writeSessionMessage(',
    );
  });

  it('throws on session-manager body-end and delivery restore edge cases', () => {
    expect(() =>
      patchSessionManager(`import x from 'y';
export function writeSessionMessage(
  agentGroupId: string,
  sessionId: string,
  message: unknown,
): void {
  void agentGroupId;
  void sessionId;
  void message;
}
`),
    ).toThrow(/writeSessionMessage body end anchor/);

    expect(() => uninstallDelivery('export const empty = 1;\n')).toThrow(
      /deliverMessage anchor missing/,
    );

    expect(() => patchRunnerIndex('export async function main() {}\n')).toThrow(
      /runner index import anchor/,
    );

    const partialRunner = `// @nanoclaw-sessionio:runner-register:begin
import { registerSessionioRunner } from './sessionio/register.js';
import fs from 'fs';
`;
    expect(patchRunnerIndex(partialRunner)).toBe(partialRunner);

    expect(() =>
      patchContainerRunner(`import { x } from 'y';
export async function wakeContainer(agentGroup: { id: string; name: string }, session: { id: string }, containerName: string): Promise<void> {
  const args: string[] = [];
}
`),
    ).toThrow(/writeSessionRouting or spawn log anchor/);

    // Missing writeSessionRouting but spawn log present → restore then patch.
    const restored = patchContainerRunner(`import { x } from 'y';
export async function wakeContainer(agentGroup: { id: string; name: string }, session: { id: string }, containerName: string): Promise<void> {
  const args: string[] = [];
  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });
}
const log = { info: (..._a: unknown[]) => undefined };
`);
    expect(restored).toContain('writeSessionRouting(agentGroup.id, session.id);');
    expect(restored).toContain('@nanoclaw-sessionio:container-runner-meta:begin');
  });
});
