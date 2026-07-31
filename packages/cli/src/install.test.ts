import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs, runCommand, isCliEntry } from './bin.js';
import {
  patchDelivery,
  patchHostSweep,
  patchIndex,
  patchRunnerIndex,
  patchSessionManager,
  scavengeUnmarkedDeliveryOutbox,
  STOCK_DELIVERY_OUTBOX,
  uninstallDelivery,
  uninstallHostSweep,
  uninstallIndex,
  uninstallSessionManager,
  FILE_TRANSFORMS,
} from './patches.js';
import {
  STOCK_CONTAINER_RUNNER,
  STOCK_DELIVERY,
  STOCK_HOST_SWEEP,
  STOCK_INDEX,
  STOCK_POLL_LOOP,
  STOCK_RUNNER_INDEX,
  STOCK_SESSION_MANAGER,
  STOCK_MESSAGES_OUT,
  STOCK_MCP_TOOLS_INDEX,
} from './test-fixtures.js';
import { findNanoclawRoot, packageRoot, rewriteHostResource } from './paths.js';
import {
  runInstall,
  runUninstall,
  runVerify,
  stageResourcesForTests,
  syncSkillToFork,
} from './install.js';

const tempRoots: string[] = [];

function makeFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionio-fixture-'));
  tempRoots.push(root);
  const files: Record<string, string> = {
    'src/session-manager.ts': STOCK_SESSION_MANAGER,
    'src/delivery.ts': STOCK_DELIVERY,
    'src/host-sweep.ts': STOCK_HOST_SWEEP,
    'src/container-runner.ts': STOCK_CONTAINER_RUNNER,
    'src/index.ts': STOCK_INDEX,
    'container/agent-runner/src/index.ts': STOCK_RUNNER_INDEX,
    'container/agent-runner/src/mcp-tools/index.ts': STOCK_MCP_TOOLS_INDEX,
    'container/agent-runner/src/poll-loop.ts': STOCK_POLL_LOOP,
    'container/agent-runner/src/db/messages-out.ts': STOCK_MESSAGES_OUT,
    '.env.example': 'FOO=1\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('bin', () => {
  it('parses command and --path', () => {
    expect(parseArgs(['node', 'bin', 'verify', '--path', '/tmp/x'])).toEqual({
      command: 'verify',
      path: '/tmp/x',
    });
  });

  it('help returns 0', () => {
    expect(runCommand(['node', 'bin', 'help'])).toBe(0);
  });

  it('unknown command returns 1', () => {
    expect(runCommand(['node', 'bin', 'nope'])).toBe(1);
  });

  it('isCliEntry compares realpaths when possible', () => {
    expect(isCliEntry('/no/such', ['node'])).toBe(false);
  });
});

describe('patches', () => {
  it('patches and uninstalls session-manager', () => {
    const patched = patchSessionManager(STOCK_SESSION_MANAGER);
    expect(patched).toContain('filesystemWriteSessionMessage');
    expect(patched).toContain('@nanoclaw-sessionio:session-manager-write:begin');
    const again = patchSessionManager(patched);
    expect(again).toBe(patched);
    const restored = uninstallSessionManager(patched);
    expect(restored).toContain('export function writeSessionMessage(');
    expect(restored).not.toContain('filesystemWriteSessionMessage');
  });

  it('patches and uninstalls delivery drainSession', () => {
    const patched = patchDelivery(STOCK_DELIVERY);
    expect(patched).toContain('resolveSessionTransport');
    expect(patched).toContain('@nanoclaw-sessionio:delivery-drain:begin');
    expect(patched).toContain('@nanoclaw-sessionio:delivery-outbox:begin');
    expect(patched).toContain('consumeOutbox');
    expect(patched).toContain('inbound DB unavailable');
    expect(patched).not.toContain('inDb as Database.Database');
    expect(patchDelivery(patched)).toBe(patched);
    const restored = uninstallDelivery(patched);
    expect(restored).toContain('outDb.close()');
    expect(restored).toContain('readOutboxFiles(session.agent_group_id, session.id, msg.id');
    expect(restored).not.toContain('consumeOutbox');
    expect(restored).not.toContain('@nanoclaw-sessionio:delivery-drain:begin');
    expect(restored).not.toContain('@nanoclaw-sessionio:delivery-outbox:begin');
    expect(restored).not.toContain('resolveSessionTransport');
    // Byte-identical round-trip — fixture has an early deliverMessage stub; the
    // restore anchor must target the real typed declaration, not the stub.
    expect(restored).toBe(STOCK_DELIVERY);
  });

  it('scavenges unmarked consumeOutbox hotfix on uninstall', () => {
    const unmarked = STOCK_DELIVERY.replace(
      `  // Read file attachments from outbox if the content declares files.
  // File I/O lives in session-manager.ts (symmetric with inbound
  // extractAttachmentFiles) — delivery just hands buffers to the adapter.
  const files =
    Array.isArray(content.files) && content.files.length > 0
      ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
      : undefined;`,
      `  // Read file attachments from outbox if the content declares files.
  // HTTP/loopback agents stage bytes on the host mailbox (no shared mount);
  // filesystem agents write under the session outbox dir. Prefer the transport
  // store, then fall back to disk for stock mounts.
  let files: OutboundFile[] | undefined;
  if (Array.isArray(content.files) && content.files.length > 0) {
    const transport = resolveSessionTransport({
      agentGroupId: session.agent_group_id,
      sessionId: session.id,
    });
    const sessionRef = {
      agentGroupId: session.agent_group_id,
      sessionId: session.id,
    };
    let fromMailbox: OutboundFile[] = [];
    for (let attempt = 0; attempt < 5 && fromMailbox.length === 0; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 150));
      const staged = await Promise.resolve(transport.consumeOutbox(sessionRef, msg.id));
      fromMailbox = staged
        .filter(
          (f): f is { name: string; data: string } =>
            typeof f.name === 'string' &&
            f.name.length > 0 &&
            typeof f.data === 'string',
        )
        .map((f) => ({
          filename: f.name,
          data: Buffer.from(f.data, 'base64'),
        }));
    }
    files =
      fromMailbox.length > 0
        ? fromMailbox
        : readOutboxFiles(
            session.agent_group_id,
            session.id,
            msg.id,
            content.files as string[],
          );
    if (!files || files.length === 0) {
      log.warn('Outbound declared files but none were staged or on disk', {
        messageId: msg.id,
        sessionId: session.id,
        declared: content.files,
      });
    }
  }`,
    );
    expect(unmarked).toContain('consumeOutbox');
    expect(unmarked).not.toContain('@nanoclaw-sessionio:delivery-outbox:begin');
    const restored = uninstallDelivery(unmarked);
    expect(restored).toContain('readOutboxFiles(session.agent_group_id, session.id, msg.id');
    expect(restored).not.toContain('consumeOutbox');
    expect(restored).not.toContain('resolveSessionTransport');
  });

  it('upgrades installs that have drain/import but lack delivery-outbox', () => {
    const good = patchDelivery(STOCK_DELIVERY);
    const withoutOutbox = good.replace(
      /\/\/ @nanoclaw-sessionio:delivery-outbox:begin[\s\S]*?\/\/ @nanoclaw-sessionio:delivery-outbox:end\r?\n?/,
      STOCK_DELIVERY_OUTBOX,
    );
    expect(withoutOutbox).toContain('@nanoclaw-sessionio:delivery-import:begin');
    expect(withoutOutbox).toContain('@nanoclaw-sessionio:delivery-drain:begin');
    expect(withoutOutbox).not.toContain('@nanoclaw-sessionio:delivery-outbox:begin');
    const upgraded = patchDelivery(withoutOutbox);
    expect(upgraded).toContain('@nanoclaw-sessionio:delivery-outbox:begin');
    expect(upgraded).toContain('consumeOutbox');
  });

  it('uninstallDelivery restores drain before stub when typed deliverMessage is absent', () => {
    // No multi-line `msg: {` signature — exercises lastIndexOf fallback.
    // Include stock outbox text so uninstall doesn't try to re-insert it.
    const stubOnly = `async function deliverMessage(_msg: unknown): Promise<null> {
  return null;
}

  // Read file attachments from outbox if the content declares files.
  // File I/O lives in session-manager.ts (symmetric with inbound
  // extractAttachmentFiles) — delivery just hands buffers to the adapter.
  const files =
    Array.isArray(content.files) && content.files.length > 0
      ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
      : undefined;
`;
    const restored = uninstallDelivery(stubOnly);
    expect(restored.indexOf('async function drainSession')).toBeLessThan(
      restored.indexOf('async function deliverMessage'),
    );
  });

  it('uninstallDelivery throws when deliverMessage anchor is missing', () => {
    expect(() => uninstallDelivery('export const empty = 1;\n')).toThrow(
      /deliverMessage anchor missing/,
    );
  });

  it('uninstallDelivery throws when stock outbox cannot be restored', () => {
    const markedOnly = `// @nanoclaw-sessionio:delivery-outbox:begin
  let files: OutboundFile[] | undefined;
// @nanoclaw-sessionio:delivery-outbox:end
async function deliverMessage(): Promise<void> {}
async function drainSession(session: Session): Promise<void> { void session; }
`;
    expect(() => uninstallDelivery(markedOnly)).toThrow(/Could not restore stock delivery outbox/);
  });

  it('scavengeUnmarkedDeliveryOutbox throws on pattern mismatch', () => {
    expect(() => scavengeUnmarkedDeliveryOutbox('const x = consumeOutbox;\n')).toThrow(
      /Could not scavenge unmarked delivery outbox/,
    );
  });

  it('scavengeUnmarkedDeliveryOutbox is a no-op when delivery-outbox is marked', () => {
    const marked = patchDelivery(STOCK_DELIVERY);
    expect(scavengeUnmarkedDeliveryOutbox(marked)).toBe(marked);
  });

  it('upgrades stale delivery drain that continued with inDb=null', () => {
    const good = patchDelivery(STOCK_DELIVERY);
    const stale = good
      .replace('inbound DB unavailable, deferring delivery', 'legacy null path')
      .replace('let inDb: Database.Database;', 'let inDb: Database.Database | null = null;')
      .replace(
        'const platformMsgId = await deliverMessage(msg, session, inDb);',
        'const platformMsgId = await deliverMessage(msg, session, inDb as Database.Database);',
      )
      .replace('inDb.close();', 'inDb?.close();');
    expect(stale).toContain('inDb as Database.Database');
    const upgraded = patchDelivery(stale);
    expect(upgraded).toContain('inbound DB unavailable');
    expect(upgraded).not.toContain('inDb as Database.Database');
  });

  it('patches host-sweep and index', () => {
    const sweep = patchHostSweep(STOCK_HOST_SWEEP);
    expect(sweep).toContain('resolveSessionTransport');
    const restoredSweep = uninstallHostSweep(sweep);
    expect(restoredSweep).not.toContain('@nanoclaw-sessionio:host-sweep-liveness:begin');
    // Stock heartbeat helper must stay at its original site, not appended at EOF.
    expect(restoredSweep.indexOf('function heartbeatMtimeMs')).toBe(
      STOCK_HOST_SWEEP.indexOf('function heartbeatMtimeMs'),
    );
    expect(restoredSweep.trimEnd()).toBe(STOCK_HOST_SWEEP.trimEnd());

    const index = patchIndex(STOCK_INDEX);
    expect(index).toContain('startSessionio');
    const restoredIndex = uninstallIndex(index);
    expect(restoredIndex).not.toContain('@nanoclaw-sessionio:index-boot:begin');
    expect(restoredIndex).toContain('startActiveDeliveryPoll();');
    expect(restoredIndex).toContain('startSweepDeliveryPoll();');
  });

  it('FILE_TRANSFORMS cover expected paths', () => {
    expect(FILE_TRANSFORMS.map((f) => f.path)).toContain('src/session-manager.ts');
    expect(FILE_TRANSFORMS.map((f) => f.path)).toContain('container/agent-runner/src/poll-loop.ts');
    expect(FILE_TRANSFORMS.map((f) => f.path)).toContain(
      'container/agent-runner/src/db/messages-out.ts',
    );
    expect(FILE_TRANSFORMS.map((f) => f.path)).toContain(
      'container/agent-runner/src/mcp-tools/index.ts',
    );
  });
});

describe('paths', () => {
  it('resolves package root and rewrites host resources', () => {
    expect(packageRoot()).toContain('nanoclaw-sessionio');
    expect(rewriteHostResource('sessionio.ts', "from './warn-once.js'")).toContain(
      'warn-once-sessionio.js',
    );
  });

  it('findNanoclawRoot finds fixture', () => {
    const root = makeFixtureRoot();
    expect(findNanoclawRoot(root)).toBe(root);
  });
});

describe('install', () => {
  it('install → verify → uninstall on fixture tree', () => {
    const root = makeFixtureRoot();
    const result = runInstall(root);
    expect(result.changed.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, 'src/sessionio.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.claude/skills/add-sessionio/SKILL.md'))).toBe(true);

    const verify = runVerify(root);
    expect(verify.ok).toBe(true);

    // idempotent upgrade
    const again = runInstall(root);
    expect(again.unchanged.length).toBeGreaterThan(0);

    const removed = runUninstall(root);
    expect(removed.removed.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, 'src/sessionio.ts'))).toBe(false);
  });

  it('syncSkillToFork copies skill', () => {
    const root = makeFixtureRoot();
    const dest = syncSkillToFork(root);
    expect(dest).toContain('add-sessionio');
    expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
  });

  it('verify reports missing call sites on unpatched stock files', () => {
    const root = makeFixtureRoot();
    const verify = runVerify(root);
    expect(verify.ok).toBe(false);
    expect(verify.issues.some((i) => i.includes('missing sessionio call sites'))).toBe(true);
  });

  it('install writes SESSIONIO keys into existing .env', () => {
    const root = makeFixtureRoot();
    fs.writeFileSync(path.join(root, '.env'), 'EXISTING=1\n');
    runInstall(root);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toContain('SESSIONIO_TRANSPORT');
  });

  it('throws when a bundled host resource is missing', () => {
    // Use an empty temp resources dir — never rename live packages/host files
    // (that races with parallel host vitest coverage in CI).
    const emptyResources = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionio-empty-res-'));
    expect(() =>
      stageResourcesForTests(emptyResources, [
        { source: 'sessionio.ts', dest: 'src/sessionio.ts' },
      ]),
    ).toThrow(/Missing bundled resource: sessionio\.ts/);
    fs.rmSync(emptyResources, { recursive: true, force: true });
  });

  it('runInstall/verify/uninstall without --path use cwd NanoClaw root', () => {
    const root = fs.realpathSync(makeFixtureRoot());
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(fs.realpathSync(runInstall().root)).toBe(root);
      expect(runVerify().ok).toBe(true);
      // Missing optional transform target is skipped on uninstall.
      fs.unlinkSync(path.join(root, 'src/host-sweep.ts'));
      const removed = runUninstall();
      expect(fs.realpathSync(removed.root)).toBe(root);
    } finally {
      process.chdir(cwd);
    }
  });

  it('verify catch stringifies non-Error throws from transforms', () => {
    const root = makeFixtureRoot();
    const target = FILE_TRANSFORMS.find((f) => f.path === 'src/delivery.ts')!;
    const original = target.transform;
    target.transform = () => {
      throw 'delivery-boom';
    };
    try {
      const verify = runVerify(root);
      expect(verify.ok).toBe(false);
      expect(verify.issues.some((i) => i.includes('delivery-boom'))).toBe(true);
    } finally {
      target.transform = original;
    }
  });

  it('scaffoldEnvKeys tolerates missing .env.example when .env exists', () => {
    const root = makeFixtureRoot();
    fs.unlinkSync(path.join(root, '.env.example'));
    fs.writeFileSync(path.join(root, '.env'), 'FOO=1\n');
    runInstall(root);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toContain('SESSIONIO_TRANSPORT');
  });

  it('syncSkillToFork replaces a non-directory destination path', () => {
    const root = makeFixtureRoot();
    const dest = path.join(root, '.claude/skills/add-sessionio');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'not-a-directory');
    const out = syncSkillToFork(root);
    expect(fs.statSync(out).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(out, 'SKILL.md'))).toBe(true);
  });
});

describe('cli commands against fixture', () => {
  it('install/verify/uninstall via runCommand', () => {
    const root = makeFixtureRoot();
    expect(runCommand(['node', 'bin', 'install', '--path', root])).toBe(0);
    expect(runCommand(['node', 'bin', 'verify', '--path', root])).toBe(0);
    expect(runCommand(['node', 'bin', 'sync-skill', '--path', root])).toBe(0);
    expect(runCommand(['node', 'bin', 'upgrade', '--path', root])).toBe(0);
    expect(runCommand(['node', 'bin', 'uninstall', '--path', root])).toBe(0);
  });
});
