/**
 * Docker `-e` injection for sessionio peer mode.
 * Used by the container-runner patch so env flags land *before* the image name.
 */

export function dockerEnvInsertIndex(args: readonly string[]): number {
  const idx = args.indexOf('--entrypoint');
  return idx >= 0 ? idx : args.length;
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

export function peerHostFromBaseUrl(baseUrl: string | undefined, fallback = 'host.docker.internal'): string {
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
 * Mutates `args` in place: injects SESSIONIO_* and NO_PROXY before `--entrypoint`.
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
