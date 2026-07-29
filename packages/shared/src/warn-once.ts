const warned = new Set<string>();

/** Shared fail-loud helper. One implementation, copied into host and runner. */
export function warnOnce(key: string, message: string, error?: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  if (error === undefined) console.warn(`[nanoclaw-sessionio] ${message}`);
  else console.warn(`[nanoclaw-sessionio] ${message}`, error);
}

export function resetWarnOnceForTests(): void {
  warned.clear();
}
