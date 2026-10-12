/**
 * @layer server
 * The Node-side REST client of an llull server (CLI backend, desktop documents, health probes):
 * one place for the auth header, the timeout and the JSON-or-error-text body. Bodies become a
 * `CommandOutcome` through `parseCommandResponse` (`@mcp/restProtocol`).
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const globalFetch: FetchLike = (url, init) => fetch(url, init);

export interface RestReply {
  readonly status: number;
  readonly ok: boolean;
  /** The parsed JSON body; `{ error: <first 200 chars> }` when the answer was not JSON. */
  readonly body: unknown;
}

interface RestRequest {
  readonly method?: 'GET' | 'POST';
  readonly token?: string | undefined;
  /** Sent as JSON. */
  readonly body?: unknown;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike | undefined;
}

/** One request; network errors and timeouts propagate (callers word them for their surface). */
export async function requestJson(url: string, request: RestRequest = {}): Promise<RestReply> {
  const hasBody = request.body !== undefined;
  const response = await (request.fetchImpl ?? globalFetch)(url, {
    method: request.method ?? (hasBody ? 'POST' : 'GET'),
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(request.token !== undefined ? { Authorization: `Bearer ${request.token}` } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
    ...(request.timeoutMs !== undefined ? { signal: AbortSignal.timeout(request.timeoutMs) } : {}),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = { error: text.slice(0, 200) };
  }
  return { status: response.status, ok: response.ok, body };
}

/** `GET <url>/health` answers 2xx within `timeoutMs`. */
export async function isHealthy(
  url: string,
  fetchImpl?: FetchLike,
  timeoutMs = 2_000,
): Promise<boolean> {
  try {
    const response = await (fetchImpl ?? globalFetch)(`${url}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}
