/**
 * @layer ui/store
 *
 * Typed fetch helpers for the server command bus.
 *
 * The server is the single source of truth. Every document mutation is sent here;
 * the updated document arrives back via the /live SSE stream, never in the response
 * body (architecture L1, PRIME DIRECTIVE).
 *
 * Error handling:
 *   - Network failure / non-ok status → throws a ServerCommandError.
 *   - Callers (`dispatch`, `undo`, `redo` in the store) catch it; see store.ts for the
 *     network-vs-HTTP and offline policy.
 * Server URL and optional bearer token come from @ui/serverConfig.
 */

import { SERVER_BASE, serverAuthHeaders } from '@ui/serverConfig';
import type { LiveSnapshotEvent } from '@mcp/liveSync';

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

/**
 * Shape returned by POST /command, POST /undo, and POST /redo.
 *
 * The document itself is NOT in this payload — it arrives via the /live SSE stream.
 */
export interface ServerCommandResponse {
  summary: string;
  affected: string[];
  isError: boolean;
  data?: unknown;
  canUndo: boolean;
  canRedo: boolean;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ServerCommandError extends Error {
  /** 'network' = fetch failed (server unreachable); 'http' = server answered non-2xx. */
  readonly kind: 'network' | 'http';
  readonly status: number | undefined;

  constructor(message: string, kind: 'network' | 'http' = 'network', status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.name = 'ServerCommandError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function postJson(path: string, body: unknown): Promise<ServerCommandResponse> {
  let response: Response;
  try {
    response = await fetch(`${SERVER_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...serverAuthHeaders() },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new ServerCommandError(
      `Network error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (!response.ok) {
    throw new ServerCommandError(
      `Server responded with HTTP ${response.status} for ${path}`,
      'http',
      response.status,
    );
  }

  return response.json() as Promise<ServerCommandResponse>;
}

/**
 * POST /command — send a named command with params to the server.
 * The updated document arrives via the /live SSE stream, not in this response.
 *
 * @throws ServerCommandError on network failure or non-ok HTTP status.
 */
export async function postCommand(name: string, params: unknown): Promise<ServerCommandResponse> {
  return postJson('/command', { name, params });
}

/**
 * POST /undo — walk back one step in server-side history.
 * The reverted document arrives via /live.
 *
 * @throws ServerCommandError on network failure or non-ok HTTP status.
 */
export async function postUndo(): Promise<ServerCommandResponse> {
  return postJson('/undo', {});
}

/**
 * POST /redo — re-apply the last undone step.
 * The re-applied document arrives via /live.
 *
 * @throws ServerCommandError on network failure or non-ok HTTP status.
 */
export async function postRedo(): Promise<ServerCommandResponse> {
  return postJson('/redo', {});
}

/** GET /live/snapshot — the server document with its log position (MG5.1 resync). */
export async function fetchLiveSnapshot(): Promise<LiveSnapshotEvent> {
  let response: Response;
  try {
    response = await fetch(`${SERVER_BASE}/live/snapshot`, { headers: serverAuthHeaders() });
  } catch (cause) {
    throw new ServerCommandError(
      `Network error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!response.ok) {
    throw new ServerCommandError(
      `Server responded with HTTP ${response.status} for /live/snapshot`,
      'http',
      response.status,
    );
  }
  return response.json() as Promise<LiveSnapshotEvent>;
}
