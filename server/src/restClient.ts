/**
 * The Node-side REST client of an llull server (CLI backend, desktop documents, health probes):
 * one place for the auth header, the timeout and the JSON-or-error-text body. Bodies become a
 * `CommandOutcome` through `parseCommandResponse` (`@protocol/restProtocol`).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isRecord } from '@lib/isRecord';

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
  return readWhole(response);
}

export interface CommandStreamRequest {
  /** Sent as JSON. */
  readonly body: unknown;
  readonly token?: string | undefined;
  /** Longest silence (no progress line, no heartbeat, no byte) before the request is abandoned. */
  readonly idleTimeoutMs: number;
  /** Longest whole request, when the caller sets one (`--timeout`). */
  readonly totalTimeoutMs?: number | undefined;
  /** Aborting closes the connection: the server cancels the command and its native jobs. */
  readonly signal?: AbortSignal | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  /** Every `progress` line the server streams, parsed. */
  readonly onProgress?: ((event: Readonly<Record<string, unknown>>) => void) | undefined;
}

const NDJSON = 'application/x-ndjson';

/** Parse one NDJSON line: a record, or null. */
function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * `POST` a command and read the answer as it streams (`Accept: application/x-ndjson`): progress lines go to `onProgress`, the `result` line is the
 * body. A server (or proxy) that answers plain JSON is read as one body, as `requestJson` does. The idle timeout restarts at every byte, so a command
 * that runs for minutes is fine while the server keeps reporting; timeouts reject with a `TimeoutError`, an aborted `signal` with an `AbortError`.
 */
export async function requestCommandStream(url: string, request: CommandStreamRequest): Promise<RestReply> {
  const controller = new AbortController();
  const fail = (name: 'TimeoutError' | 'AbortError', message: string): void => controller.abort(new DOMException(message, name));
  const idleMessage = `no answer for ${request.idleTimeoutMs / 1000}s`;
  let idle = setTimeout(() => fail('TimeoutError', idleMessage), request.idleTimeoutMs);
  const touch = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => fail('TimeoutError', idleMessage), request.idleTimeoutMs);
  };
  const totalMs = request.totalTimeoutMs;
  const total = totalMs === undefined ? undefined : setTimeout(() => fail('TimeoutError', `no answer in ${totalMs / 1000}s`), totalMs);
  const onAbort = (): void => fail('AbortError', 'cancelled');
  if (request.signal?.aborted === true) onAbort();
  request.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await (request.fetchImpl ?? globalFetch)(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: `${NDJSON}, application/json`,
        ...(request.token !== undefined ? { Authorization: `Bearer ${request.token}` } : {}),
      },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    touch();
    if (!(response.headers.get('content-type') ?? '').includes(NDJSON) || response.body === null) return await readWhole(response);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let result: unknown;
    const line = (text: string): void => {
      if (text.trim() === '') return;
      const event = parseLine(text);
      if (event === null) return;
      if (event['type'] === 'progress') request.onProgress?.(event);
      else if (event['type'] === 'result') result = event['result'];
    };
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      touch();
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const text of lines) line(text);
    }
    line(pending + decoder.decode());
    return {
      status: response.status,
      ok: response.ok && result !== undefined,
      body: result ?? { error: 'the server closed the stream without a result' },
    };
  } finally {
    clearTimeout(idle);
    if (total !== undefined) clearTimeout(total);
    request.signal?.removeEventListener('abort', onAbort);
  }
}

async function readWhole(response: Response): Promise<RestReply> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = { error: text.slice(0, 200) };
  }
  return { status: response.status, ok: response.ok, body };
}

/** `GET <url>/health` answers 2xx within `timeoutMs`; with `token` it must also answer the HMAC challenge. */
export async function isHealthy(url: string, fetchImpl?: FetchLike, timeoutMs = 2_000, token?: string): Promise<boolean> {
  try {
    const challenge = token === undefined ? '' : randomBytes(16).toString('hex');
    const query = token === undefined ? '' : `?challenge=${challenge}`;
    const response = await (fetchImpl ?? globalFetch)(`${url}/health${query}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || token === undefined) return response.ok;
    // the answerer must prove it knows the per-launch token (HMAC of our challenge), else it is not our backend
    const body = (await response.json()) as { proof?: unknown };
    const expected = createHmac('sha256', token).update(challenge).digest('hex');
    return (
      typeof body.proof === 'string' &&
      body.proof.length === expected.length &&
      timingSafeEqual(Buffer.from(body.proof), Buffer.from(expected))
    );
  } catch {
    return false;
  }
}
