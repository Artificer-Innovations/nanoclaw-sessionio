export function getDeliveredIds(_db: unknown): Set<string> {
  return new Set();
}
export function getDueOutboundMessages(_db: unknown): Array<{
  id: string;
  kind: string;
  timestamp: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  in_reply_to: string | null;
}> {
  return [];
}
export function getProcessingClaims(
  _db: unknown,
): Array<{ message_id: string; status_changed: string }> {
  return [];
}
export function markDelivered(_db: unknown, _id: string, _platform: string | null): void {}
export function replaceDestinations(_db: unknown, _rows: unknown[]): void {}
export function syncProcessingAcks(_inDb: unknown, _outDb: unknown): void {}
export function countDueMessages(_db: unknown): number {
  return 0;
}
