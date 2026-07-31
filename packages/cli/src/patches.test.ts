import { describe, expect, it } from 'vitest';
import {
  patchContainerRunner,
  patchIndex,
  patchMcpToolsIndex,
  patchMessagesOut,
  patchPollLoop,
  patchRunnerIndex,
  patchSessionManager,
  uninstallContainerRunner,
  uninstallDelivery,
  uninstallIndex,
  uninstallMcpToolsIndex,
  uninstallMessagesOut,
  uninstallPollLoop,
  uninstallSessionManager,
  scavengeUnmarkedMcpSessionioRegister,
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

  it('upgrades stale empty-meta that wrapped writeSessionRouting inside the marker', () => {
    // Older installs put writeSessionRouting inside container-runner-meta.
    const stale = STOCK_CONTAINER_RUNNER.replace(
      '  writeSessionRouting(agentGroup.id, session.id);',
      `${begin('container-runner-meta')}
  writeSessionRouting(agentGroup.id, session.id);
  {
    const transport = resolveSessionTransport({
      agentGroupId: agentGroup.id,
      sessionId: session.id,
    });
    void transport.syncSessionMeta?.(
      { agentGroupId: agentGroup.id, sessionId: session.id },
      {},
    );
  }
${end('container-runner-meta')}`,
    );
    expect(stale).toContain('{},\n    );');
    const upgraded = patchContainerRunner(stale);
    expect(upgraded).toContain('writeSessionRouting(agentGroup.id, session.id);');
    expect(upgraded).toContain('@nanoclaw-sessionio:container-runner-meta:begin');
    expect(upgraded).toContain('session_routing');
    expect(upgraded).not.toContain('{},\n    );');
  });

  it('uninstall restores writeSessionRouting when old meta marker ate it', () => {
    const withOld = STOCK_CONTAINER_RUNNER.replace(
      '  writeSessionRouting(agentGroup.id, session.id);',
      `${begin('container-runner-meta')}
  writeSessionRouting(agentGroup.id, session.id);
  { void 0; }
${end('container-runner-meta')}`,
    );
    expect(withOld.match(/writeSessionRouting\(agentGroup\.id, session\.id\);/g)).toHaveLength(1);
    const restored = uninstallContainerRunner(withOld);
    expect(restored).not.toContain('container-runner-meta');
    expect(restored).toContain('writeSessionRouting(agentGroup.id, session.id);');
    expect(restored).toContain(
      "log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });",
    );
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

  it('applies host /meta destinations via writable inbound DB (Fly volume)', () => {
    const poll = patchPollLoop(STOCK_POLL_LOOP);
    // Must not use the read-only singleton — RO writes fail silently on Fly
    // and leave destinations empty → from="unknown:…" → dropped replies.
    expect(poll).toContain('openInboundDbWritable');
    expect(poll).toContain('resetInboundDbCache');
    expect(poll).not.toContain('{ getInboundDb }');
    expect(poll).not.toContain('getInboundDb()');
    expect(poll).toContain('sessionioApplyHostMeta failed');
    // bun:sqlite needs $prefixed keys; @name binds as NULL and breaks allowlists.
    expect(poll).toContain('$name');
    expect(poll).toContain('$channel_type');
    expect(poll).not.toContain('VALUES (@name,');
    // Cache reset must run in finally so partial writes still invalidate RO reads.
    expect(poll).toMatch(/finally \{[\s\S]*?resetInboundDbCache/);
    expect(poll).not.toMatch(/resetInboundDbCache\(\);\n  \} catch/);
    // getMeta + import must be inside the logged try (caller swallows errors).
    expect(poll).toMatch(/try \{\r?\n\s*const meta = await peer\.getMeta\(session\);/);
  });

  it('upgrades stale poll-loop that applied /meta via read-only getInboundDb', () => {
    const good = patchPollLoop(STOCK_POLL_LOOP);
    const roApply = `async function sessionioApplyHostMeta(
  peer: NonNullable<ReturnType<typeof getSessionioPeer>>,
  session: ReturnType<typeof sessionRefFromEnv>,
) {
  const meta = await peer.getMeta(session);
  try {
    const { getInboundDb } = await import('./db/connection.js');
    const db = getInboundDb();
    if (meta.routing) {
      db.prepare('SELECT 1').run();
    }
    if (meta.destinations) {
      db.prepare('DELETE FROM destinations').run();
    }
  } catch {
    // Local SQLite projection is best-effort.
  }
}`;
    const stale = good.replace(
      /async function sessionioApplyHostMeta\([\s\S]*?\n\}\n\nasync function sessionioStageOutboxFiles/,
      `${roApply}\n\nasync function sessionioStageOutboxFiles`,
    );
    expect(stale).toContain('{ getInboundDb }');
    expect(stale).not.toContain('openInboundDbWritable');
    const upgraded = patchPollLoop(stale);
    expect(upgraded).toContain('openInboundDbWritable');
    expect(upgraded).toContain('resetInboundDbCache');
    expect(upgraded).not.toContain('{ getInboundDb }');
    expect(upgraded).toContain('sessionioApplyHostMeta failed');
    expect(upgraded).toContain('$name');
  });

  it('upgrades stale poll-loop that used @named binds (bun NULL inserts)', () => {
    const good = patchPollLoop(STOCK_POLL_LOOP);
    const stale = good.replaceAll('$name', '@name').replaceAll('$display_name', '@display_name');
    // Enough to trip the VALUES (@name, upgrade guard even if other $keys remain.
    expect(stale).toContain('VALUES (@name,');
    const upgraded = patchPollLoop(stale);
    expect(upgraded).toContain('$name');
    expect(upgraded).not.toContain('VALUES (@name,');
  });

  it('upgrades stale poll-loop that ran getMeta outside the logged try', () => {
    const good = patchPollLoop(STOCK_POLL_LOOP);
    // Prior shape: getMeta + import before try; failures bypass console.error and
    // are swallowed by sessionioGetPendingMessages's blank catch.
    const staleApply = `async function sessionioApplyHostMeta(
  peer: NonNullable<ReturnType<typeof getSessionioPeer>>,
  session: ReturnType<typeof sessionRefFromEnv>,
) {
  const meta = await peer.getMeta(session);
  const { openInboundDbWritable, resetInboundDbCache } = await import('./db/connection.js');
  let db: ReturnType<typeof openInboundDbWritable> | undefined;
  try {
    db = openInboundDbWritable();
    if (meta.routing) {
      db.prepare('SELECT 1').run();
    }
  } catch (err) {
    console.error(
      \`[agent-runner] sessionioApplyHostMeta failed: \${
        err instanceof Error ? err.message : String(err)
      }\`,
    );
  } finally {
    // Always drop the RO singleton after any write attempt so partial applies
    // (e.g. routing committed, destinations tx threw) are visible to readers.
    if (db) {
      try {
        resetInboundDbCache();
      } catch {
        // ignore cache-reset errors
      }
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
  }
}`;
    const stale = good.replace(
      /async function sessionioApplyHostMeta\([\s\S]*?\n\}\n\nasync function sessionioStageOutboxFiles/,
      `${staleApply}\n\nasync function sessionioStageOutboxFiles`,
    );
    expect(stale).toContain(
      'const meta = await peer.getMeta(session);\n  const { openInboundDbWritable',
    );
    expect(stale).not.toMatch(/try \{\r?\n\s*const meta = await peer\.getMeta\(session\);/);
    const upgraded = patchPollLoop(stale);
    expect(upgraded).toMatch(/try \{\r?\n\s*const meta = await peer\.getMeta\(session\);/);
    expect(upgraded).toContain('sessionioApplyHostMeta failed');
  });

  it('upgrades stale poll-loop that only reset RO cache on full success', () => {
    const good = patchPollLoop(STOCK_POLL_LOOP);
    // Simulate prior patch: reset only after both writes, not in finally.
    const finallyStart = good.indexOf('  } finally {\n    // Always drop the RO singleton');
    expect(finallyStart).toBeGreaterThan(0);
    const catchStart = good.lastIndexOf('  } catch (err) {', finallyStart);
    expect(catchStart).toBeGreaterThan(0);
    const stale =
      `${good.slice(0, catchStart)}resetInboundDbCache();\n` +
      `  } catch (err) {
    console.error(
      \`[agent-runner] sessionioApplyHostMeta failed: \${
        err instanceof Error ? err.message : String(err)
      }\`,
    );
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
}` +
      good.slice(good.indexOf('\n\nasync function sessionioStageOutboxFiles', finallyStart));
    expect(stale).toMatch(/resetInboundDbCache\(\);\n  \} catch/);
    expect(stale).not.toMatch(/finally \{[\s\S]*?resetInboundDbCache/);
    const upgraded = patchPollLoop(stale);
    expect(upgraded).toMatch(/finally \{[\s\S]*?resetInboundDbCache/);
    expect(upgraded).not.toMatch(/resetInboundDbCache\(\);\n  \} catch/);
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

  it('uninstall scavenges bare sessionioWriteMessageOut leftovers without await', () => {
    const leftover = `async function deliverErrorResult(text: string): Promise<void> {
  return sessionioWriteMessageOut({
    id: 'x',
    content: JSON.stringify({ text }),
  }).then(() => undefined);
}
`;
    const cleaned = uninstallPollLoop(leftover);
    expect(cleaned).not.toContain('sessionioWriteMessageOut');
    expect(cleaned).toContain('writeMessageOut({');
    expect(cleaned).not.toContain('.then(() => undefined)');
  });

  it('patches mcp-tools register and scavenges unmarked boots', () => {
    const stock = `import './core.js';
import { startMcpServer } from './server.js';
`;
    const patched = patchMcpToolsIndex(stock);
    expect(patched).toContain('@nanoclaw-sessionio:mcp-register:begin');
    expect(patched).toContain('registerSessionioRunner');
    expect(patchMcpToolsIndex(patched)).toBe(patched);
    expect(uninstallMcpToolsIndex(patched)).not.toContain('registerSessionioRunner');

    const unmarked = `// Sessionio peer registration is optional here: writeMessageOut gates on
// SESSIONIO_TRANSPORT via isRemotePeerMode(). Still register so peer-aware
// call sites (if any) work inside the MCP child process.
import { registerSessionioRunner } from '../sessionio/register.js';
registerSessionioRunner();

import './core.js';
`;
    expect(scavengeUnmarkedMcpSessionioRegister(unmarked)).not.toContain('registerSessionioRunner');
    expect(uninstallMcpToolsIndex(unmarked)).not.toContain('registerSessionioRunner');
  });

  it('patchMcpToolsIndex throws without an import anchor', () => {
    expect(() => patchMcpToolsIndex('export {};\n')).toThrow(/mcp-tools import anchor/);
  });

  it('scavengeUnmarkedMcpSessionioRegister throws on pattern mismatch', () => {
    expect(() =>
      scavengeUnmarkedMcpSessionioRegister(
        "import { registerSessionioRunner } from '../sessionio/register.js';\n",
      ),
    ).toThrow(/Could not scavenge unmarked mcp-tools/);
  });

  it('scavengeUnmarkedMcpSessionioRegister is a no-op when mcp-register is marked', () => {
    const marked = patchMcpToolsIndex(`import './core.js';\n`);
    expect(scavengeUnmarkedMcpSessionioRegister(marked)).toBe(marked);
  });

  it('patches messages-out peer bridge through outbound-sync helpers', () => {
    const patched = patchMessagesOut(STOCK_MESSAGES_OUT);
    expect(patched).toContain('postOutboundSync');
    expect(patched).toContain('buildOutboundSyncCurlArgs');
    expect(patched).toContain('buildOutboxSyncCurlArgs');
    expect(patched).toContain('isRemotePeerMode()');
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
    expect(patched).toContain('buildOutboxSyncCurlArgs');
    const stale = patched.replaceAll('buildOutboxSyncCurlArgs', 'legacyStageCurl');
    expect(stale).toContain('buildOutboundSyncCurlArgs');
    expect(stale).not.toContain('buildOutboxSyncCurlArgs');
    const upgraded = patchMessagesOut(stale);
    expect(upgraded).toContain('buildOutboxSyncCurlArgs');
  });

  it('upgrades marked messages-out that still gates on getSessionioPeer', () => {
    const patched = patchMessagesOut(STOCK_MESSAGES_OUT);
    const stale = patched
      .replaceAll('isRemotePeerMode', 'getSessionioPeer')
      .replaceAll('buildOutboxSyncCurlArgs', 'legacyStageCurl');
    // Force upgrade: missing buildOutboxSyncCurlArgs + peer gate
    expect(stale).not.toContain('isRemotePeerMode');
    const upgraded = patchMessagesOut(stale);
    expect(upgraded).toContain('isRemotePeerMode()');
    expect(upgraded).toContain('buildOutboxSyncCurlArgs');
  });

  it('upgrades marked messages-out that still put JSON body in curl argv', () => {
    const patched = patchMessagesOut(STOCK_MESSAGES_OUT);
    expect(patched).toContain('TextEncoder().encode(body)');
    const staleOutbox = patched.replaceAll(
      'TextEncoder().encode(outboxBody)',
      '/* no stdin outbox */',
    );
    expect(patchMessagesOut(staleOutbox)).toContain('TextEncoder().encode(outboxBody)');
    const staleBody = patched.replaceAll('TextEncoder().encode(body)', '/* no stdin body */');
    expect(staleBody).toContain('TextEncoder().encode(outboxBody)');
    expect(staleBody).not.toContain('TextEncoder().encode(body)');
    expect(patchMessagesOut(staleBody)).toContain('TextEncoder().encode(body)');
  });

  it('upgrades marked messages-out that only lacks isRemotePeerMode gate', () => {
    const patched = patchMessagesOut(STOCK_MESSAGES_OUT);
    const stale = patched.replaceAll('isRemotePeerMode()', 'getSessionioPeer()');
    expect(stale).toContain('buildOutboundSyncCurlArgs');
    expect(stale).toContain('buildOutboxSyncCurlArgs');
    expect(stale).not.toContain('isRemotePeerMode()');
    const upgraded = patchMessagesOut(stale);
    expect(upgraded).toContain('isRemotePeerMode()');
    expect(upgraded).toContain('buildOutboxSyncCurlArgs');
  });

  it('leaves unmarked sandbox peer bridge alone when already using outbound-sync', () => {
    const unmarked = `import { getConfig } from '../config.js';

function postOutboundSync(msg: { id: string }): number {
  void buildOutboundSyncCurlArgs;
  void buildOutboxSyncCurlArgs;
  void isRemotePeerMode();
  const body = '{}';
  void Bun.spawnSync([], { stdin: new TextEncoder().encode(body) });
  return 0;
}

export function writeMessageOut(msg: { id: string }): number {
  return postOutboundSync(msg);
}
`;
    expect(patchMessagesOut(unmarked)).toBe(unmarked);
  });

  it('upgrades legacy unmarked peer bridge without duplicating postOutboundSync', () => {
    const legacy = `import { getConfig } from '../config.js';
import { getSessionioPeer } from '../sessionio/register.js';

function postOutboundSync(msg: WriteMessageOut): number {
  const peer = getSessionioPeer();
  if (!peer) throw new Error('no peer');
  void peer.stageOutbox;
  return 0;
}

export function writeMessageOut(msg: WriteMessageOut): number {
  if (getSessionioPeer()) {
    return postOutboundSync(msg);
  }
  const outbound = getOutboundDb();
  return 1;
}
`;
    const upgraded = patchMessagesOut(legacy);
    expect(upgraded.match(/function postOutboundSync\(/g)).toHaveLength(1);
    expect(upgraded).toContain('@nanoclaw-sessionio:messages-out-helper:begin');
    expect(upgraded).toContain('isRemotePeerMode()');
    expect(upgraded).toContain('buildOutboxSyncCurlArgs');
    expect(upgraded).not.toContain('peer.stageOutbox');
    // Legacy unmarked gate removed; marked gate is the only remaining call site.
    expect(upgraded.match(/return postOutboundSync\(msg\);/g)).toHaveLength(1);
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
    expect(uninstallSessionManager(reinstalled)).toContain('export function writeSessionMessage(');
  });

  it('throws on session-manager body-end and delivery restore edge cases', () => {
    expect(() =>
      patchSessionManager(`import x from 'y';
export function nope(): void {}
`),
    ).toThrow(/writeSessionMessage export/);

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
