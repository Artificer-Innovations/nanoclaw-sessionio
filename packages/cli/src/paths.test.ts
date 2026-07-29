import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findNanoclawRoot,
  hostResourcesDir,
  packageRoot,
  readPackageVersion,
  rewriteHostResource,
  runnerResourcesDir,
  skillDir,
} from './paths.js';

describe('paths', () => {
  it('locates resources', () => {
    expect(packageRoot()).toMatch(/nanoclaw-sessionio$/);
    expect(skillDir()).toContain('add-sessionio');
    expect(hostResourcesDir()).toContain('host');
    expect(runnerResourcesDir()).toContain('runner');
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rewrites all host resource filenames', () => {
    expect(rewriteHostResource('transports.ts', "from './types.js'")).toContain('sessionio-types');
    expect(rewriteHostResource('http-server.ts', "from './transports.js'")).toContain(
      'sessionio-transports',
    );
    expect(rewriteHostResource('sessionio-boot.ts', "from './http-server.js'")).toContain(
      'sessionio-http-server',
    );
    expect(rewriteHostResource('docker-env-inject.ts', 'export const x = 1')).toBe(
      'export const x = 1',
    );
    expect(rewriteHostResource('sessionio.ts', "from './warn-once.js'")).toContain(
      'warn-once-sessionio',
    );
    expect(
      rewriteHostResource('sessionio.conformance.test.ts', "from './transports.js'"),
    ).toContain('sessionio-transports');
    expect(rewriteHostResource('types.ts', 'x')).toBe('x');
    expect(rewriteHostResource('warn-once.ts', 'x')).toBe('x');
    expect(rewriteHostResource('other.ts', 'unchanged')).toBe('unchanged');
  });

  it('falls back to skill resources when packages/*/src is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionio-paths-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'nanoclaw-sessionio', version: '0.0.0' }),
    );
    fs.mkdirSync(path.join(root, 'skills/add-sessionio/resources/host'), { recursive: true });
    fs.mkdirSync(path.join(root, 'skills/add-sessionio/resources/runner'), { recursive: true });
    fs.mkdirSync(path.join(root, 'packages/cli/src'), { recursive: true });
    const start = path.join(root, 'packages/cli/src');
    expect(hostResourcesDir(start)).toBe(
      path.join(root, 'skills/add-sessionio/resources/host'),
    );
    expect(runnerResourcesDir(start)).toBe(
      path.join(root, 'skills/add-sessionio/resources/runner'),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('throws when package root cannot be located', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-sessionio-pkg-'));
    expect(() => packageRoot(dir)).toThrow(/Could not locate nanoclaw-sessionio package root/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws when NanoClaw root missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-nanoclaw-'));
    expect(() => findNanoclawRoot(dir)).toThrow(/NanoClaw root not found/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips malformed package.json while walking for package root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionio-malformed-'));
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'package.json'), '{not-json');
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'nanoclaw-sessionio', version: '9.9.9' }),
    );
    expect(packageRoot(nested)).toBe(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
