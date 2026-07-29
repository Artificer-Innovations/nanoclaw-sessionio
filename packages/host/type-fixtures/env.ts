export function readEnvFile(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (process.env[key]) result[key] = process.env[key]!;
  }
  return result;
}
