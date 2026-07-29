import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface CopyRule {
  source: string;
  dest: string;
}

export const HOST_COPY_RULES: CopyRule[] = [
  { source: 'warn-once.ts', dest: 'src/warn-once-sessionio.ts' },
  { source: 'types.ts', dest: 'src/sessionio-types.ts' },
  { source: 'sessionio.ts', dest: 'src/sessionio.ts' },
  { source: 'transports.ts', dest: 'src/sessionio-transports.ts' },
  { source: 'http-server.ts', dest: 'src/sessionio-http-server.ts' },
  { source: 'sessionio-boot.ts', dest: 'src/sessionio-boot.ts' },
  { source: 'sessionio.conformance.test.ts', dest: 'src/sessionio.conformance.test.ts' },
];

export const RUNNER_COPY_RULES: CopyRule[] = [
  { source: 'warn-once.ts', dest: 'container/agent-runner/src/sessionio/warn-once.ts' },
  { source: 'types.ts', dest: 'container/agent-runner/src/sessionio/types.ts' },
  { source: 'peer.ts', dest: 'container/agent-runner/src/sessionio/peer.ts' },
  { source: 'mailbox.ts', dest: 'container/agent-runner/src/sessionio/mailbox.ts' },
  { source: 'register.ts', dest: 'container/agent-runner/src/sessionio/register.ts' },
];

export const ENV_KEYS = [
  'SESSIONIO_TRANSPORT',
  'SESSIONIO_HTTP_HOST',
  'SESSIONIO_HTTP_PORT',
  'SESSIONIO_BASE_URL',
  'SESSIONIO_HTTP_TOKEN',
] as const;

export function packageRoot(startDir: string = __dirname): string {
  let dir = startDir;
  for (;;) {
    const packagePath = path.join(dir, 'package.json');
    if (fs.existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { name?: string };
        if (pkg.name === 'nanoclaw-sessionio') return dir;
        /* v8 ignore next 3 */
      } catch {
        // Malformed package.json along the way must not mask a valid root higher up.
      }
    }
    const parent = path.dirname(dir);
    /* v8 ignore next 2 */
    if (parent === dir) break;
    dir = parent;
  }
  /* v8 ignore next */
  throw new Error('Could not locate nanoclaw-sessionio package root');
}

export function skillDir(startDir: string = __dirname): string {
  return path.join(packageRoot(startDir), 'skills/add-sessionio');
}

export function hostResourcesDir(startDir: string = __dirname): string {
  const source = path.join(packageRoot(startDir), 'packages/host/src');
  /* v8 ignore next */
  if (fs.existsSync(path.join(source, 'sessionio.ts'))) return source;
  /* v8 ignore next */
  return path.join(skillDir(startDir), 'resources/host');
}

export function runnerResourcesDir(startDir: string = __dirname): string {
  const source = path.join(packageRoot(startDir), 'packages/runner/src');
  /* v8 ignore next */
  if (fs.existsSync(path.join(source, 'peer.ts'))) return source;
  /* v8 ignore next */
  return path.join(skillDir(startDir), 'resources/runner');
}

export function findNanoclawRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (
      fs.existsSync(path.join(dir, 'src/session-manager.ts')) &&
      fs.existsSync(path.join(dir, 'src/delivery.ts')) &&
      fs.existsSync(path.join(dir, 'container/agent-runner/src/poll-loop.ts'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'NanoClaw root not found (expected src/session-manager.ts, src/delivery.ts, container/agent-runner/src/poll-loop.ts). Use --path.',
  );
}

export function readPackageVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as {
    version?: string;
  };
  /* v8 ignore next */
  return pkg.version ?? '0.0.0';
}

/** Rewrite host module imports after copy (split files use local names in package). */
export function rewriteHostResource(filename: string, content: string): string {
  let next = content;
  if (filename === 'sessionio.ts') {
    next = next.replaceAll("from './warn-once.js'", "from './warn-once-sessionio.js'");
    next = next.replaceAll("from './types.js'", "from './sessionio-types.js'");
  }
  if (filename === 'transports.ts') {
    next = next.replaceAll("from './types.js'", "from './sessionio-types.js'");
  }
  if (filename === 'http-server.ts') {
    next = next
      .replaceAll("from './transports.js'", "from './sessionio-transports.js'")
      .replaceAll("from './types.js'", "from './sessionio-types.js'");
  }
  if (filename === 'sessionio-boot.ts') {
    next = next
      .replaceAll("from './http-server.js'", "from './sessionio-http-server.js'")
      .replaceAll("from './sessionio.js'", "from './sessionio.js'")
      .replaceAll("from './transports.js'", "from './sessionio-transports.js'")
      .replaceAll("from './types.js'", "from './sessionio-types.js'");
  }
  if (filename === 'sessionio.conformance.test.ts') {
    next = next.replaceAll("from './transports.js'", "from './sessionio-transports.js'");
  }
  if (filename === 'warn-once.ts' || filename === 'types.ts') {
    return next;
  }
  return next;
}
