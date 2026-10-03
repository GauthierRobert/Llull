/**
 * @layer server
 *
 * MCP session registry and its idle-TTL sweep (transport bookkeeping only).
 */

import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  /** Epoch-ms of the last request routed to this session. Updated on every hit. */
  lastSeenMs: number;
}

/**
 * Live session map: session id → entry.
 * Created on MCP `initialize`; removed by any of three paths:
 *   1. HTTP DELETE  → SDK calls `onsessionclosed`
 *   2. Transport close (e.g. SDK-level cleanup) → `transport.onclose`
 *   3. Idle TTL sweep → `startSessionSweep` evicts entries not seen within TTL
 * The session's document is held in a closure inside the Server's handlers.
 */
export const sessions = new Map<string, SessionEntry>();

/**
 * Default TTL / sweep interval (overridden by env vars).
 *
 * `MCP_SESSION_TTL_MS`   — max idle time before a session is evicted (default 30 min).
 * `MCP_SESSION_SWEEP_MS` — how often the sweep runs (default 60 s).
 *
 * Idle-TTL eviction is the catch-all for HTTP clients that abandon a session
 * without sending DELETE and without triggering a transport close event.
 * Active sessions are never evicted — every routed request touches `lastSeenMs`.
 */
const DEFAULT_TTL_MS = 30 * 60_000; // 30 min
const DEFAULT_SWEEP_MS = 60_000; // 60 s

function parsePosInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Start the background sweep.  The timer is `.unref()`'d so it never blocks
 * process exit.  Call once from `buildMcpRouter` — the singleton pattern
 * ensures only one sweep runs per process even if the router is rebuilt.
 */
let sweepStarted = false;

export function startSessionSweep(): void {
  if (sweepStarted) return;
  sweepStarted = true;

  const ttlMs = parsePosInt(process.env['MCP_SESSION_TTL_MS'], DEFAULT_TTL_MS);
  const sweepMs = parsePosInt(process.env['MCP_SESSION_SWEEP_MS'], DEFAULT_SWEEP_MS);

  console.warn(`[mcp] session sweep started — TTL ${ttlMs} ms, sweep every ${sweepMs} ms`);

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastSeenMs >= ttlMs) {
        console.warn(`[mcp] evicting idle session ${id} (idle ${now - entry.lastSeenMs} ms)`);
        sessions.delete(id);
        // Best-effort close; ignore errors (transport may already be gone).
        entry.transport.close().catch(() => {});
      }
    }
  }, sweepMs);

  // Do not keep the process alive just for housekeeping.
  timer.unref();
}
/** Close and forget every MCP session (shutdown path). */
export async function closeAllSessions(): Promise<void> {
  const entries = [...sessions.values()];
  sessions.clear();
  await Promise.all(entries.map((entry) => entry.transport.close().catch(() => {})));
}

/** Number of live sessions (test helper). @internal */
export function _sessionCount(): number {
  return sessions.size;
}
