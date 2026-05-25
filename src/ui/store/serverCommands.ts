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
 *   - Callers (`dispatch`, `undo`, `redo` in the store) catch and reflect the error
 *     as a 'disconnected' liveStatus + descriptive lastSummary.
 */

const SERVER_BASE = 'http://localhost:3001';

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
  constructor(message: string) {
    super(message);
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new ServerCommandError(`Network error: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  if (!response.ok) {
    throw new ServerCommandError(`Server responded with HTTP ${response.status} for ${path}`);
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
