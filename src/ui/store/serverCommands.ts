// Fetch helpers of the server command bus. The new document arrives over the /live SSE stream, never in the
// response body (L1). Network failure / non-ok status → ServerCommandError (offline policy: store.ts).

import { SERVER_BASE, serverAuthHeaders } from '@ui/serverConfig';
import { errorMessage } from '@lib/errorMessage';
import type { LiveSnapshotEvent } from '@mcp/liveSync';
import type { CommandResponseBody } from '@mcp/restProtocol';

/** POST /command, /undo, /redo body (`@mcp/restProtocol`); older servers omit `changed`. */
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

const httpStatusOf = (err: unknown): number | undefined =>
  err instanceof ServerCommandError && err.kind === 'http' ? err.status : undefined;

/** Statuses that refuse ONE command (bad params, too large, unprocessable). */
const COMMAND_REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);
/** Statuses that refuse the REQUEST itself (server/src/security.ts: token, origin, route). */
const CONNECTION_REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

/** Refused this one command, retrying cannot fix it: drop it. Anything else (connection refusals, 408, 429, 5xx, network) keeps it. */
export function isCommandRefusal(err: unknown): err is ServerCommandError {
  const status = httpStatusOf(err);
  return status !== undefined && COMMAND_REFUSAL_STATUSES.has(status);
}

/** Refused whatever the command (auth, origin, missing route): stop syncing, keep queued edits, never adopt the server snapshot over them. */
export function isConnectionRefusal(err: unknown): err is ServerCommandError {
  const status = httpStatusOf(err);
  return status !== undefined && CONNECTION_REFUSAL_STATUSES.has(status);
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

/** POST /exchange: a host transport tool (fea_mesh, fea_solve, export_step …); its document changes arrive over /live. */
export function postExchange(name: string, params: unknown): Promise<ServerCommandResponse> {
  return request('/exchange', { name, params });
}
