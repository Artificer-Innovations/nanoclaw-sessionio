import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry, main, parseArgs, runCommand } from './bin.js';
import * as install from './install.js';
import {
  STOCK_CONTAINER_RUNNER,
  STOCK_DELIVERY,
  STOCK_HOST_SWEEP,
  STOCK_INDEX,
  STOCK_MESSAGES_OUT,
  STOCK_POLL_LOOP,
  STOCK_RUNNER_INDEX,
  STOCK_SESSION_MANAGER,
} from './test-fixtures.js';

function makeMiniRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionio-bin-'));
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

describe('bin parseArgs', () => {
  it('defaults to help', () => {
    expect(parseArgs(['node', 'x']).command).toBe('help');
  });
});

describe('bin runCommand errors', () => {
  it('returns 1 when verify fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionio-verify-fail-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'container/agent-runner/src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/session-manager.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(root, 'src/delivery.ts'), 'export const x = 1;\n');
    fs.writeFileSync(
      path.join(root, 'container/agent-runner/src/poll-loop.ts'),
      'export const x = 1;\n',
    );
    expect(runCommand(['node', 'bin', 'verify', '--path', root])).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns 1 when install throws', () => {
    expect(runCommand(['node', 'bin', 'install', '--path', '/tmp/does-not-exist-sessionio'])).toBe(
      1,
    );
  });

  it('sync-skill without --path uses findNanoclawRoot from cwd', () => {
    const root = makeMiniRoot();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(runCommand(['node', 'bin', 'sync-skill'])).toBe(0);
    } finally {
      process.chdir(cwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stringifies non-Error throws', () => {
    const spy = vi.spyOn(install, 'runInstall').mockImplementation(() => {
      throw 'plain-string-failure';
    });
    expect(runCommand(['node', 'bin', 'install', '--path', '/tmp/x'])).toBe(1);
    spy.mockRestore();
  });

  it('isCliEntry matches same path and catch fallback', () => {
    const self = fileURLToPath(import.meta.url);
    expect(isCliEntry(self, ['node', self])).toBe(true);
    expect(isCliEntry(self, ['node', `${self}-nope`])).toBe(false);
    expect(isCliEntry('/no/such/cli', ['node', '/no/such/cli'])).toBe(true);
    expect(isCliEntry('/no/such/cli', ['node', '/other'])).toBe(false);
  });

  it('main exits via runCommand', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const argv = process.argv;
    process.argv = ['node', 'bin', 'help'];
    main();
    expect(exitSpy).toHaveBeenCalledWith(0);
    process.argv = argv;
    exitSpy.mockRestore();
  });
});
