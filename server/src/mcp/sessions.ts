/**
 * @layer server
 * MCP session registry and its idle-TTL sweep (transport bookkeeping only).
 */

import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  /** Epoch-ms of the last request routed to this session. */
  lastSeenMs: number;
}

/** Session id -> entry. Removed on DELETE, on transport close, or by the idle sweep. */
export const sessions = new Map<string, SessionEntry>();

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_SWEEP_MS = 60_000;

function parsePosInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

  const ttlMs = parsePosInt(process.env['MCP_SESSION_TTL_MS'], DEFAULT_TTL_MS);
  const sweepMs = parsePosInt(process.env['MCP_SESSION_SWEEP_MS'], DEFAULT_SWEEP_MS);
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
