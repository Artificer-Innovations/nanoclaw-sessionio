import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry, main, parseArgs, runCommand } from './bin.js';

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

  it('isCliEntry matches same path', () => {
    const self = fileURLToPath(import.meta.url);
    expect(isCliEntry(self, ['node', self])).toBe(true);
    expect(isCliEntry(self, ['node', `${self}-nope`])).toBe(false);
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
