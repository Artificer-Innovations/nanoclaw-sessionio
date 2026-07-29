/**
 * NanoClaw does not dotenv-load arbitrary keys into process.env.
 * Sessionio boot applies SESSIONIO_* from `.env` when unset.
 */

export const SESSIONIO_ENV_KEYS = [
  'SESSIONIO_TRANSPORT',
  'SESSIONIO_HTTP_HOST',
  'SESSIONIO_HTTP_PORT',
  'SESSIONIO_BASE_URL',
  'SESSIONIO_HTTP_TOKEN',
] as const;

export type SessionioEnvKey = (typeof SESSIONIO_ENV_KEYS)[number];

/** Defaults used when starting the HTTP mailbox server. */
export const SESSIONIO_DEFAULT_HTTP_HOST = '0.0.0.0';
export const SESSIONIO_DEFAULT_HTTP_PORT = 18765;

export function applySessionioEnvFromFile(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (keys: string[]) => Record<string, string> = () => ({}),
): void {
  const fromFile = readFile([...SESSIONIO_ENV_KEYS]);
  for (const key of SESSIONIO_ENV_KEYS) {
    const value = fromFile[key];
    if (value && !env[key]?.trim()) {
      env[key] = value;
    }
  }
}
