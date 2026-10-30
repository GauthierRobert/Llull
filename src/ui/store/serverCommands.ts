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
async function request<Body>(path: string, postBody?: unknown, signal?: AbortSignal): Promise<Body> {
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
            ...(signal === undefined ? {} : { signal }),
          },
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
export function postCommand(name: string, params: unknown, commandId?: string, signal?: AbortSignal): Promise<ServerCommandResponse> {
  return request('/command', commandId === undefined ? { name, params } : { name, params, commandId }, signal);
}

/** Host tool over POST /exchange (`topology_solve`, exchange tools): not a document command, so not in the command log. */
export function postExchange(name: string, params: unknown): Promise<ServerCommandResponse> {
  return request('/exchange', { name, params });
}

export function postUndo(): Promise<ServerCommandResponse> {
  return request('/undo', {});
}

export function postRedo(): Promise<ServerCommandResponse> {
  return request('/redo', {});
}

/** The newest local crash report with its command log (SC-A4); rejects (404) when there is none. */
export function fetchLatestCrashReport(): Promise<unknown> {
  return request('/crashes/latest');
}

/** Server document with its log position (resync). */
export function fetchLiveSnapshot(): Promise<LiveSnapshotEvent> {
  return request('/live/snapshot');
}
