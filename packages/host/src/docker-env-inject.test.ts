import { describe, expect, it } from 'vitest';
import {
  dockerEnvInsertIndex,
  injectSessionioContainerEnv,
  mergeNoProxy,
  peerHostFromBaseUrl,
  pushDockerEnvFlag,
  readExistingNoProxyFromArgs,
} from './docker-env-inject.js';

/** Typical docker run shape: flags, then --entrypoint, image, -c script. */
function sampleDockerArgs(): string[] {
  return [
    'run',
    '--rm',
    '-v',
    '/tmp/x:/data',
    '--entrypoint',
    '/bin/bash',
    'nanoclaw-agent:local',
    '-c',
    'echo hi',
  ];
}

function envKeysBeforeEntrypoint(args: string[]): string[] {
  const cut = dockerEnvInsertIndex(args);
  const keys: string[] = [];
  for (let i = 0; i < cut - 1; i++) {
    if (args[i] === '-e' && args[i + 1]?.includes('=')) {
      keys.push(args[i + 1]!.split('=')[0]!);
    }
  }
  return keys;
}

describe('docker-env-inject (split-brain / -e-after-image regressions)', () => {
  it('inserts SESSIONIO_* and NO_PROXY before --entrypoint, not after the image', () => {
    const args = sampleDockerArgs();
    injectSessionioContainerEnv(args, {
      transport: 'loopback',
      baseUrl: 'http://host.docker.internal:18765',
      token: 'secret',
      sessionId: 'sess-1',
      agentGroupId: 'ag-1',
    });

    const entryIdx = args.indexOf('--entrypoint');
    expect(entryIdx).toBeGreaterThan(0);
    const imageIdx = args.indexOf('nanoclaw-agent:local');
    expect(imageIdx).toBeGreaterThan(entryIdx);

    for (const key of [
      'SESSIONIO_TRANSPORT',
      'SESSIONIO_BASE_URL',
      'SESSIONIO_HTTP_TOKEN',
      'SESSIONIO_SESSION_ID',
      'SESSIONIO_AGENT_GROUP_ID',
      'NO_PROXY',
      'no_proxy',
    ]) {
      const flagIdx = args.findIndex((a, i) => a === '-e' && args[i + 1]?.startsWith(`${key}=`));
      expect(flagIdx).toBeGreaterThanOrEqual(0);
      expect(flagIdx).toBeLessThan(entryIdx);
      expect(flagIdx).toBeLessThan(imageIdx);
    }

    // Regression: appending after image would put -e next to -c (bash args).
    expect(args.slice(imageIdx).join(' ')).not.toMatch(/-e SESSIONIO_/);
  });

  it('keeps -e flags before image when --entrypoint is missing (append-safe index)', () => {
    const args = ['run', '--rm', 'nanoclaw-agent:local', '-c', 'echo'];
    expect(dockerEnvInsertIndex(args)).toBe(args.length);
    injectSessionioContainerEnv(args, {
      sessionId: 's',
      agentGroupId: 'a',
      baseUrl: 'http://10.0.0.5:18765',
    });
    expect(envKeysBeforeEntrypoint(args)).toContain('SESSIONIO_SESSION_ID');
    expect(args.join(' ')).toContain('NO_PROXY=10.0.0.5,127.0.0.1,localhost');
  });

  it('upserts existing -e without duplicating and merges NO_PROXY for OneCLI bypass', () => {
    const args = sampleDockerArgs();
    args.splice(2, 0, '-e', 'NO_PROXY=corp.internal', '-e', 'SESSIONIO_SESSION_ID=old');
    injectSessionioContainerEnv(args, {
      sessionId: 'new',
      agentGroupId: 'ag',
      baseUrl: 'http://host.docker.internal:18765',
      hostNoProxy: 'from-host',
    });
    const sessionFlags = args.filter(
      (a, i) => a === '-e' && args[i + 1]?.startsWith('SESSIONIO_SESSION_ID='),
    );
    expect(sessionFlags).toHaveLength(1);
    expect(args).toContain('SESSIONIO_SESSION_ID=new');
    const noProxy = args.find((a) => a.startsWith('NO_PROXY='));
    expect(noProxy).toMatch(/corp\.internal/);
    expect(noProxy).toMatch(/host\.docker\.internal/);
  });

  it('pushDockerEnvFlag and mergeNoProxy helpers', () => {
    const args = ['a', '--entrypoint', 'bash'];
    pushDockerEnvFlag(args, 'FOO', '1', dockerEnvInsertIndex(args));
    pushDockerEnvFlag(args, 'FOO', '', dockerEnvInsertIndex(args));
    expect(args.filter((x) => x.startsWith('FOO='))).toEqual(['FOO=1']);
    expect(mergeNoProxy('a,b', 'b,c')).toBe('a,b,c');
    expect(peerHostFromBaseUrl(undefined)).toBe('host.docker.internal');
    expect(peerHostFromBaseUrl('')).toBe('host.docker.internal');
    expect(peerHostFromBaseUrl('http://x.test:9/path')).toBe('x.test');
    expect(peerHostFromBaseUrl('not a url')).toBe('host.docker.internal');
    // Defensive empty-hostname path (rare); force via URL override.
    const RealURL = globalThis.URL;
    globalThis.URL = class extends RealURL {
      constructor(input: string | URL, base?: string | URL) {
        super(input, base);
        Object.defineProperty(this, 'hostname', { get: () => '' });
      }
    } as typeof URL;
    expect(peerHostFromBaseUrl('http://example.test')).toBe('host.docker.internal');
    globalThis.URL = RealURL;
    expect(readExistingNoProxyFromArgs(['-e', 'NO_PROXY=z'], 'fallback')).toBe('z');
    expect(readExistingNoProxyFromArgs([], 'fallback')).toBe('fallback');
  });
});
