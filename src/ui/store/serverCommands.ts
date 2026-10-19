// Fetch helpers of the server command bus. The new document arrives over the /live SSE stream, never in the
// response body (L1). Network failure / non-ok status → ServerCommandError (local fallback: onlineMode.ts).

import { SERVER_BASE, serverAuthHeaders } from '@ui/serverConfig';
import { errorMessage } from '@lib/errorMessage';
import type { LiveSnapshotEvent } from '@protocol/liveSync';
import type { CommandResponseBody } from '@protocol/restProtocol';

/** POST /command, /undo, /redo body (`@protocol/restProtocol`); older servers omit `changed`. */
export type ServerCommandResponse = Omit<CommandResponseBody, 'changed'> & { changed?: boolean };

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

/** GET `path`, or POST `postBody` as JSON. */
async function request<Body>(path: string, postBody?: unknown): Promise<Body> {
  let response: Response;
  try {
    response = await fetch(
      `${SERVER_BASE}${path}`,
      postBody === undefined
        ? { headers: serverAuthHeaders() }
        : { method: 'POST', headers: { 'Content-Type': 'application/json', ...serverAuthHeaders() }, body: JSON.stringify(postBody) },
    );
  } catch (cause) {
    throw new ServerCommandError(`Network error: ${errorMessage(cause)}`);
  }
  if (!response.ok) {
    throw new ServerCommandError(`Server responded with HTTP ${response.status} for ${path}`, 'http', response.status);
  }
  return response.json() as Promise<Body>;
}

/** `commandId` makes it idempotent server-side. @throws ServerCommandError (as do undo / redo / snapshot) */
export function postCommand(name: string, params: unknown, commandId?: string): Promise<ServerCommandResponse> {
  return request('/command', commandId === undefined ? { name, params } : { name, params, commandId });
}

export function postUndo(): Promise<ServerCommandResponse> {
  return request('/undo', {});
}

export function postRedo(): Promise<ServerCommandResponse> {
  return request('/redo', {});
}

/** Server document with its log position (resync). */
export function fetchLiveSnapshot(): Promise<LiveSnapshotEvent> {
  return request('/live/snapshot');
}
