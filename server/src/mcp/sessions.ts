/** MCP session registry and its idle-TTL sweep (transport bookkeeping only). */

import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { positiveInteger } from '../env';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  /** Epoch-ms of the last request routed to this session. */
  lastSeenMs: number;
  /** Named user that opened the session (named-user mode); other users cannot reuse the id. */
  userId?: string;
  /** Locality of the creating request (`!isLocalPeer`); a request of the other locality is refused (licensed redaction is fixed per session). */
  remote: boolean;
}

/** Session id -> entry. Removed on DELETE, on transport close, or by the idle sweep. */
export const sessions = new Map<string, SessionEntry>();

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_SWEEP_MS = 60_000;
const DEFAULT_MAX_SESSIONS = 256;

/** `MCP_MAX_SESSIONS` (default 256): a new session evicts the least recently used one when full. */
function maxSessions(): number {
  return positiveInteger(process.env['MCP_MAX_SESSIONS'], DEFAULT_MAX_SESSIONS);
}

/**
 * Make room for one more session by closing the oldest-idle ones while at/over the cap. With a known `userId`
 * that user's own sessions go first (a user at the cap recycles their own); a caller with none evicts by global LRU.
 */
export function evictForCapacity(userId?: string): void {
  const limit = maxSessions();
  while (sessions.size >= limit) {
    const owned = userId === undefined ? false : [...sessions.values()].some((entry) => entry.userId === userId);
    let oldestId: string | undefined;
    let oldestSeen = Infinity;
    for (const [id, entry] of sessions) {
      if (owned && entry.userId !== userId) continue;
      if (entry.lastSeenMs < oldestSeen) {
        oldestSeen = entry.lastSeenMs;
        oldestId = id;
      }
    }
    if (oldestId === undefined) return;
    const entry = sessions.get(oldestId);
    sessions.delete(oldestId);
    console.warn(`[mcp] session cap ${limit} reached; evicting oldest idle session ${oldestId}`);
    entry?.transport.close().catch(() => {});
  }
}

let sweepStarted = false;

/**
 * Evict sessions idle longer than `MCP_SESSION_TTL_MS` (30 min), checked every
 * `MCP_SESSION_SWEEP_MS` (60 s): the catch-all for clients that vanish without DELETE or a close.
 * Idempotent; the timer is unref'd so it never blocks process exit.
 */
export function startSessionSweep(): void {
  if (sweepStarted) return;
  sweepStarted = true;

  const ttlMs = positiveInteger(process.env['MCP_SESSION_TTL_MS'], DEFAULT_TTL_MS);
  const sweepMs = positiveInteger(process.env['MCP_SESSION_SWEEP_MS'], DEFAULT_SWEEP_MS);
  console.warn(`[mcp] session sweep started — TTL ${ttlMs} ms, sweep every ${sweepMs} ms`);

  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastSeenMs >= ttlMs) {
        console.warn(`[mcp] evicting idle session ${id} (idle ${now - entry.lastSeenMs} ms)`);
        sessions.delete(id);
        entry.transport.close().catch(() => {}); // the transport may already be gone
      }
    }
  }, sweepMs).unref();
}

/** Close and forget every MCP session (shutdown path). */
export async function closeAllSessions(): Promise<void> {
  const entries = [...sessions.values()];
  sessions.clear();
  await Promise.all(entries.map((entry) => entry.transport.close().catch(() => {})));
}
