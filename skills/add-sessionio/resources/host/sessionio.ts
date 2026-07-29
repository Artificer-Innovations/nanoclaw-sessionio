import { resetWarnOnceForTests, warnOnce } from './warn-once.js';
import {
  SESSIONIO_API_VERSION,
  normalizeTransportName,
  type SessionRef,
  type SessionTransport,
  type SessionTransportName,
} from './types.js';

export { SESSIONIO_API_VERSION } from './types.js';
export type {
  Attachment,
  InboundMessage,
  Liveness,
  OutboundMessage,
  ProcessingAck,
  SessionMeta,
  SessionRef,
  SessionTransport,
  SessionTransportName,
} from './types.js';
export { normalizeTransportName } from './types.js';
export { warnOnce } from './warn-once.js';

const transports = new Map<string, SessionTransport>();
let defaultTransportName: string = 'filesystem';
let resolveOverride: ((session: SessionRef) => string | undefined) | null = null;

function assertTransport(name: string, transport: unknown): void {
  if (!name.trim()) throw new Error('Session transport name must not be empty');
  if (!transport || typeof transport !== 'object') {
    throw new TypeError(`Session transport "${name}" must be an object`);
  }
}

export function registerSessionTransport(name: string, transport: SessionTransport): () => void {
  assertTransport(name, transport);
  const key = normalizeTransportName(name);
  transports.set(key, transport);
  return () => {
    if (transports.get(key) === transport) transports.delete(key);
  };
}

export function setDefaultSessionTransport(name: SessionTransportName): void {
  defaultTransportName = normalizeTransportName(name);
}

export function setSessionTransportResolver(
  resolver: ((session: SessionRef) => string | undefined) | null,
): void {
  resolveOverride = resolver;
}

export function resolveTransportName(session: SessionRef): string {
  const fromSession = normalizeTransportName(session.transportName);
  if (session.transportName && fromSession) {
    if (session.transportName.trim()) return fromSession;
  }
  if (resolveOverride) {
    const resolved = resolveOverride(session);
    if (resolved) return normalizeTransportName(resolved);
  }
  const fromEnv = normalizeTransportName(process.env.SESSIONIO_TRANSPORT);
  if (process.env.SESSIONIO_TRANSPORT?.trim()) return fromEnv;
  return defaultTransportName;
}

export function resolveSessionTransport(session: SessionRef): SessionTransport {
  const name = resolveTransportName(session);
  const transport = transports.get(name);
  if (!transport) {
    throw new Error(
      `Session transport "${name}" is not registered. Install nanoclaw-sessionio and ensure boot registered builtins.`,
    );
  }
  return transport;
}

export function getSessionioCapabilities(): {
  apiVersion: typeof SESSIONIO_API_VERSION;
  features: {
    registerSessionTransport: true;
    resolveSessionTransport: true;
    filesystem: boolean;
    http: boolean;
  };
  counts: { transports: number };
  defaultTransport: string;
  transports: string[];
} {
  return {
    apiVersion: SESSIONIO_API_VERSION,
    features: {
      registerSessionTransport: true,
      resolveSessionTransport: true,
      filesystem: transports.has('filesystem'),
      http: transports.has('http'),
    },
    counts: { transports: transports.size },
    defaultTransport: defaultTransportName,
    transports: [...transports.keys()].sort(),
  };
}

export function probeSessionioCapabilities(
  load: () => ReturnType<typeof getSessionioCapabilities>,
):
  | {
      present: true;
      apiVersion: number;
      features: Record<string, boolean>;
      counts: Record<string, number>;
    }
  | { present: false; reason: 'absent'; error?: unknown } {
  try {
    const caps = load();
    return {
      present: true,
      apiVersion: caps.apiVersion,
      features: caps.features,
      counts: caps.counts,
    };
  } catch (error) {
    return { present: false, reason: 'absent', error };
  }
}

export function resetSessionioForTests(): void {
  transports.clear();
  defaultTransportName = 'filesystem';
  resolveOverride = null;
  resetWarnOnceForTests();
}

export function listRegisteredTransports(): string[] {
  return [...transports.keys()].sort();
}

/** Soft warn when an illegal pairing is detected by consumers (agenthosts). */
export function warnIllegalTransportRuntimePair(transport: string, runtime: string): void {
  if (normalizeTransportName(transport) === 'filesystem' && runtime === 'fly') {
    warnOnce(
      `illegal-pair:${transport}:${runtime}`,
      `Illegal pairing: filesystem session transport cannot be used with remote runtime "${runtime}". Use http.`,
    );
  }
}
