/**
 * Pure helpers for the sync `writeMessageOut` → HTTP peer bridge (MCP / agenttrace).
 * Bun.spawnSync(curl) stays in the patched messages-out call site; URL/args are tested here.
 */

export interface OutboundSyncCurlOptions {
  baseUrl: string;
  agentGroupId: string;
  sessionId: string;
  token?: string;
  body: string;
  /** curl --connect-timeout seconds. Default 5. */
  connectTimeoutSec?: number;
  /** curl --max-time seconds. Default 15. */
  maxTimeSec?: number;
}

function baseCurlArgs(options: OutboundSyncCurlOptions, pathAndQuery: string): string[] {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('SESSIONIO_BASE_URL is required in http/loopback mode');
  const url = `${baseUrl}${pathAndQuery}`;

  const connectTimeout = options.connectTimeoutSec ?? 5;
  const maxTime = options.maxTimeSec ?? 15;

  const args = [
    'curl',
    '-sS',
    '--connect-timeout',
    String(connectTimeout),
    '--max-time',
    String(maxTime),
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '-X',
    'POST',
    '-H',
    'content-type: application/json',
  ];
  if (options.token) {
    args.push('-H', `Authorization: Bearer ${options.token}`);
  }
  args.push('-d', options.body, url);
  return args;
}

/** Build curl argv for a synchronous outbound POST (no trailing slash on baseUrl required). */
export function buildOutboundSyncCurlArgs(options: OutboundSyncCurlOptions): string[] {
  const q =
    `?agentGroupId=${encodeURIComponent(options.agentGroupId)}` +
    `&sessionId=${encodeURIComponent(options.sessionId)}`;
  return baseCurlArgs(options, `/outbound${q}`);
}

/** Stage outbox attachments BEFORE posting outbound so the host never races an empty mailbox. */
export function buildOutboxSyncCurlArgs(options: OutboundSyncCurlOptions): string[] {
  const q =
    `?agentGroupId=${encodeURIComponent(options.agentGroupId)}` +
    `&sessionId=${encodeURIComponent(options.sessionId)}`;
  return baseCurlArgs(options, `/outbox${q}`);
}

/** Clear proxy vars so OneCLI/HTTP_PROXY cannot swallow mailbox traffic. */
export function clearedProxyEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  return {
    ...env,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    ALL_PROXY: '',
    all_proxy: '',
  };
}
