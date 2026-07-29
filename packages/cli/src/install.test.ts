import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs, runCommand, isCliEntry } from './bin.js';
import {
  patchDelivery,
  patchHostSweep,
  patchIndex,
  patchSessionManager,
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
} from './test-fixtures.js';
import { findNanoclawRoot, packageRoot, rewriteHostResource } from './paths.js';
import { runInstall, runUninstall, runVerify, syncSkillToFork } from './install.js';

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
    expect(patchDelivery(patched)).toBe(patched);
    const restored = uninstallDelivery(patched);
    expect(restored).toContain('outDb.close()');
    expect(restored).not.toContain('@nanoclaw-sessionio:delivery-drain:begin');
  });

  it('patches host-sweep and index', () => {
    const sweep = patchHostSweep(STOCK_HOST_SWEEP);
    expect(sweep).toContain('resolveSessionTransport');
    expect(uninstallHostSweep(sweep)).not.toContain(
      '@nanoclaw-sessionio:host-sweep-liveness:begin',
    );

    const index = patchIndex(STOCK_INDEX);
    expect(index).toContain('startSessionio');
    expect(uninstallIndex(index)).not.toContain('@nanoclaw-sessionio:index-boot:begin');
  });

  it('FILE_TRANSFORMS cover expected paths', () => {
    expect(FILE_TRANSFORMS.map((f) => f.path)).toContain('src/session-manager.ts');
    expect(FILE_TRANSFORMS.map((f) => f.path)).toContain('container/agent-runner/src/poll-loop.ts');
    expect(FILE_TRANSFORMS.map((f) => f.path)).toContain(
      'container/agent-runner/src/db/messages-out.ts',
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

  it('verify fails when anchors moved', () => {
    const root = makeFixtureRoot();
    fs.writeFileSync(path.join(root, 'src/delivery.ts'), 'export const broken = true;\n');
    expect(() => runInstall(root)).toThrow(/anchor/i);
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
