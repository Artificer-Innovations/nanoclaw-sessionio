import { describe, expect, it } from 'vitest';
import {
  applySessionioEnvFromFile,
  SESSIONIO_DEFAULT_HTTP_HOST,
  SESSIONIO_DEFAULT_HTTP_PORT,
  SESSIONIO_ENV_KEYS,
} from './sessionio-env.js';

describe('sessionio-env (.env not auto-loaded into process.env)', () => {
  it('documents Docker-reachable HTTP bind defaults', () => {
    expect(SESSIONIO_DEFAULT_HTTP_HOST).toBe('0.0.0.0');
    expect(SESSIONIO_DEFAULT_HTTP_PORT).toBe(18765);
    expect(SESSIONIO_ENV_KEYS).toContain('SESSIONIO_TRANSPORT');
    expect(SESSIONIO_ENV_KEYS).toContain('SESSIONIO_BASE_URL');
  });

  it('applies SESSIONIO_* from file only when process env is unset/blank', () => {
    const env: NodeJS.ProcessEnv = {
      SESSIONIO_TRANSPORT: '',
      SESSIONIO_HTTP_PORT: '9999',
    };
    applySessionioEnvFromFile(env, () => ({
      SESSIONIO_TRANSPORT: 'loopback',
      SESSIONIO_HTTP_HOST: '0.0.0.0',
      SESSIONIO_HTTP_PORT: '18765',
      SESSIONIO_BASE_URL: 'http://host.docker.internal:18765',
      SESSIONIO_HTTP_TOKEN: 'tok',
    }));
    expect(env.SESSIONIO_TRANSPORT).toBe('loopback');
    expect(env.SESSIONIO_HTTP_HOST).toBe('0.0.0.0');
    expect(env.SESSIONIO_HTTP_PORT).toBe('9999'); // already set — do not override
    expect(env.SESSIONIO_BASE_URL).toBe('http://host.docker.internal:18765');
    expect(env.SESSIONIO_HTTP_TOKEN).toBe('tok');
  });

  it('uses default empty reader when none provided', () => {
    const env: NodeJS.ProcessEnv = {};
    applySessionioEnvFromFile(env);
    expect(env.SESSIONIO_TRANSPORT).toBeUndefined();
  });

  it('does nothing when file has no values', () => {
    const env: NodeJS.ProcessEnv = {};
    applySessionioEnvFromFile(env, () => ({}));
    expect(env.SESSIONIO_TRANSPORT).toBeUndefined();
  });
});
