/**
 * Docker `-e` injection for sessionio peer mode.
 * Used by the container-runner patch so env flags land *before* the image name.
 */

/** `docker run` options that consume the next argv token as a value. */
const DOCKER_RUN_VALUE_OPTS = new Set([
  '-e',
  '--env',
  '--env-file',
  '-v',
  '--volume',
  '-w',
  '--workdir',
  '-u',
  '--user',
  '-p',
  '--publish',
  '-m',
  '--memory',
  '--memory-reservation',
  '--memory-swap',
  '--name',
  '--network',
  '--net',
  '--entrypoint',
  '-h',
  '--hostname',
  '--add-host',
  '--device',
  '-l',
  '--label',
  '--cidfile',
  '--cpus',
  '--cpuset-cpus',
  '--gpus',
  '--group-add',
  '--health-cmd',
  '--health-interval',
  '--health-retries',
  '--health-timeout',
  '--ipc',
  '--ip',
  '--link',
  '--log-driver',
  '--log-opt',
  '--mac-address',
  '--mount',
  '--pid',
  '--platform',
  '--restart',
  '--runtime',
  '--security-opt',
  '--shm-size',
  '--stop-signal',
  '--stop-timeout',
  '--tmpfs',
  '--ulimit',
  '--userns',
  '--uts',
  '--volume-driver',
  '--volumes-from',
  '--cgroup-parent',
  '--blkio-weight',
  '--cpu-shares',
  '--cpu-period',
  '--cpu-quota',
]);

/**
 * Index at which to splice `-e` flags so they remain docker *options*
 * (before IMAGE), not container command args.
 *
 * Prefers `--entrypoint` when present (NanoClaw's usual shape); otherwise
 * walks `docker run` argv to find the image token.
 */
export function dockerEnvInsertIndex(args: readonly string[]): number {
  const entryIdx = args.indexOf('--entrypoint');
  if (entryIdx >= 0) return entryIdx;

  let i = 0;
  if (args[i] === 'docker') i += 1;
  if (args[i] === 'run') i += 1;

  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--') {
      return Math.min(i + 1, args.length);
    }
    if (!arg.startsWith('-')) {
      return i;
    }
    // --opt=value form (no separate value token)
    if (arg.startsWith('--') && arg.includes('=')) {
      i += 1;
      continue;
    }
    if (DOCKER_RUN_VALUE_OPTS.has(arg)) {
      i += 2;
      continue;
    }
    // Boolean / clustered short flags (-it, --rm, -d, …)
    i += 1;
  }
  return args.length;
}

/** Upsert `-e KEY=value` at `insertAt` (before `--entrypoint` / image). */
export function pushDockerEnvFlag(
  args: string[],
  key: string,
  value: string | undefined,
  insertAt: number,
): void {
  if (value == null || value === '') return;
  const prefix = `${key}=`;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-e' && args[i + 1]!.startsWith(prefix)) {
      args[i + 1] = `${key}=${value}`;
      return;
    }
  }
  args.splice(insertAt, 0, '-e', `${key}=${value}`);
}

export function mergeNoProxy(current: string | undefined, extra: string): string {
  const parts = new Set(
    `${current ?? ''},${extra}`
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  );
  return [...parts].join(',');
}

export function peerHostFromBaseUrl(
  baseUrl: string | undefined,
  fallback = 'host.docker.internal',
): string {
  if (!baseUrl) return fallback;
  try {
    const hostname = new URL(baseUrl).hostname;
    if (!hostname) return fallback;
    return hostname;
  } catch {
    return fallback;
  }
}

export function readExistingNoProxyFromArgs(
  args: readonly string[],
  fallback?: string,
): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-e' && args[i + 1]!.startsWith('NO_PROXY=')) {
      return args[i + 1]!.slice('NO_PROXY='.length);
    }
  }
  return fallback;
}

export interface InjectSessionioContainerEnvOptions {
  transport?: string;
  baseUrl?: string;
  token?: string;
  sessionId: string;
  agentGroupId: string;
  /** Host process NO_PROXY when args do not already set one. */
  hostNoProxy?: string;
}

/**
 * Mutates `args` in place: injects SESSIONIO_* and NO_PROXY before `--entrypoint` / image.
 * Caller should only invoke when transport resolves to http.
 */
export function injectSessionioContainerEnv(
  args: string[],
  options: InjectSessionioContainerEnvOptions,
): void {
  const insertAt = dockerEnvInsertIndex(args);
  const pushEnv = (key: string, value: string | undefined) =>
    pushDockerEnvFlag(args, key, value, insertAt);

  pushEnv('SESSIONIO_TRANSPORT', options.transport ?? 'http');
  pushEnv('SESSIONIO_BASE_URL', options.baseUrl);
  pushEnv('SESSIONIO_HTTP_TOKEN', options.token);
  pushEnv('SESSIONIO_SESSION_ID', options.sessionId);
  pushEnv('SESSIONIO_AGENT_GROUP_ID', options.agentGroupId);

  const peerHost = peerHostFromBaseUrl(options.baseUrl);
  const existingNoProxy = readExistingNoProxyFromArgs(args, options.hostNoProxy);
  const noProxy = mergeNoProxy(existingNoProxy, `${peerHost},127.0.0.1,localhost`);
  pushEnv('NO_PROXY', noProxy);
  pushEnv('no_proxy', noProxy);
}
