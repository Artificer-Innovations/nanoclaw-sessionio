export function clearOutbox(_a: string, _s: string, _m: string): void {}
export function filesystemWriteSessionMessage(
  _agentGroupId: string,
  _sessionId: string,
  _message: unknown,
): void {}
export function heartbeatPath(agentGroupId: string, sessionId: string): string {
  return `/tmp/${agentGroupId}/${sessionId}/.heartbeat`;
}
export function initSessionFolder(_a: string, _s: string): void {}
export function inboundDbPath(agentGroupId: string, sessionId: string): string {
  return `/tmp/${agentGroupId}/${sessionId}/inbound.db`;
}
export function openInboundDb(_a: string, _s: string): { close(): void } {
  return { close() {} };
}
export function openOutboundDb(_a: string, _s: string): { close(): void } {
  return { close() {} };
}
export function readOutboxFiles(
  _a: string,
  _s: string,
  _m: string,
  _filenames: string[],
): Array<{ filename: string; data: Buffer }> | undefined {
  return [];
}
export function sessionDir(agentGroupId: string, sessionId: string): string {
  return `/tmp/${agentGroupId}/${sessionId}`;
}
export function writeSessionRouting(_a: string, _s: string): void {}
export function writeSessionMessage(_a: string, _s: string, _m: unknown): void {}
