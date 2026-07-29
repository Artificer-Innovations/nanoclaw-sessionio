/**
 * Runner registration — when remote peer mode is active, expose the HTTP client
 * for poll-loop patches to use instead of local SQLite.
 */
import { createPeerFromEnv, isRemotePeerMode, SessionioPeerClient } from './peer.js';

let peer: SessionioPeerClient | null = null;

export function registerSessionioRunner(): void {
  peer = createPeerFromEnv();
}

export function getSessionioPeer(): SessionioPeerClient | null {
  return peer;
}

export function resetSessionioRunnerForTests(): void {
  peer = null;
}

export { isRemotePeerMode, SessionioPeerClient };
