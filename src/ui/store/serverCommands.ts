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
import { errorMessage } from '@lib/errorMessage';
import type { LiveSnapshotEvent } from '@mcp/liveSync';

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

/** GET `path`, or POST it with `postBody` as JSON when given. Resolves to the parsed JSON response. */
async function request<Body>(path: string, postBody?: unknown): Promise<Body> {
  let response: Response;
  try {
    response = await fetch(
      `${SERVER_BASE}${path}`,
      postBody === undefined
        ? { headers: serverAuthHeaders() }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...serverAuthHeaders() },
            body: JSON.stringify(postBody),
          },
    );
  } catch (cause) {
    throw new ServerCommandError(`Network error: ${errorMessage(cause)}`);
  }
  if (!response.ok) {
    throw new ServerCommandError(
      `Server responded with HTTP ${response.status} for ${path}`,
      'http',
      response.status,
    );
  }
  return response.json() as Promise<Body>;
}

/**
 * POST /command — send a named command with params to the server.
 * `commandId` makes the request idempotent server-side (a repeated id is not re-applied).
 *
 * @throws ServerCommandError on network failure or non-ok HTTP status (also for undo / redo / snapshot).
 */
export function postCommand(
  name: string,
  params: unknown,
  commandId?: string,
): Promise<ServerCommandResponse> {
  return request(
    '/command',
    commandId === undefined ? { name, params } : { name, params, commandId },
  );
}

/** POST /undo — walk back one step in server-side history. */
export function postUndo(): Promise<ServerCommandResponse> {
  return request('/undo', {});
}

/** POST /redo — re-apply the last undone step. */
export function postRedo(): Promise<ServerCommandResponse> {
  return request('/redo', {});
}

/** GET /live/snapshot — the server document with its log position (resync). */
export function fetchLiveSnapshot(): Promise<LiveSnapshotEvent> {
  return request('/live/snapshot');
}
