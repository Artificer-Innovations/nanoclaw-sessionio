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
    expect(
      rewriteHostResource('sessionio.conformance.test.ts', "from './transports.js'"),
    ).toContain('sessionio-transports');
    expect(rewriteHostResource('types.ts', 'x')).toBe('x');
  });

  it('throws when NanoClaw root missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-nanoclaw-'));
    expect(() => findNanoclawRoot(dir)).toThrow(/NanoClaw root not found/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
