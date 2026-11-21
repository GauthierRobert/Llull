/**
 * The renderer's end of `capture_viewport` (ASC M6a): holds `GET <SERVER_BASE>/viewport/stream` (SSE, ticket auth) open and answers each `capture`
 * event with a frame (`POST /viewport/frame/:id`) drawn by the mounted 3D canvas (`CaptureRig`), or with the reason it could not.
 * - one frame at a time (`captureQueue.ts`); a `cancel { id }` event drops a frame not yet started
 * - a frame is of the document state the backend asked for: the renderer waits until its live document has that content hash (`/live` and this stream are
 *   separate connections, so the command that changed the document may arrive after the request) and answers VIEWPORT_STALE after `STALE_AFTER_MS`
 * onerror: reconnect with a fresh ticket (1s..30s backoff).
 */

import { useEffect } from 'react';
import type { ViewportCaptureRequest } from '@core/model/viewportCapture';
import { uint8ArrayToBase64 } from '@lib/base64';
import { isRecord } from '@lib/isRecord';
import { pow } from '@lib/pow';
import { documentHash } from '@protocol/liveSync';
import { SERVER_BASE, hasApiToken, serverAuthHeaders, ticketStreamUrl } from '@ui/serverConfig';
import { useStore } from '@ui/store';
import { createCaptureQueue } from '@ui/viewport/3d/capture/captureQueue';
import { captureFrame } from '@ui/viewport/3d/capture/captureRegistry';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;
const STALE_AFTER_MS = 5000;

interface CaptureEvent {
  readonly id: string;
  readonly request: ViewportCaptureRequest;
  readonly documentHash: string;
}

class CaptureRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function parseEvent(raw: string): CaptureEvent | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) && typeof value['id'] === 'string' && typeof value['documentHash'] === 'string' && isRecord(value['request'])
      ? (value as unknown as CaptureEvent)
      : null;
  } catch {
    return null;
  }
}

const liveHash = (): string => documentHash(useStore.getState().liveBase);

/** Resolves when the live document has content hash `wanted`; rejects VIEWPORT_STALE after `STALE_AFTER_MS`, or `cancelled` when `signal` aborts. */
function documentReaches(wanted: string, signal: AbortSignal): Promise<void> {
  if (liveHash() === wanted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = (outcome: () => void): void => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
      outcome();
    };
    const onAbort = (): void => finish(() => reject(new Error('cancelled')));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new CaptureRefusal('VIEWPORT_STALE', 'the app has not received the latest document state (live sync is behind)')),
        ),
      STALE_AFTER_MS,
    );
    const unsubscribe = useStore.subscribe(() => {
      if (liveHash() === wanted) finish(resolve);
    });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function answer(event: CaptureEvent, signal: AbortSignal): Promise<void> {
  let body: Record<string, unknown>;
  try {
    await documentReaches(event.documentHash, signal);
    const frame = await captureFrame(event.request);
    body = { png: uint8ArrayToBase64(frame.png), width: frame.width, height: frame.height };
  } catch (error) {
    if (signal.aborted) return; // the backend gave up on it: nobody waits for an answer
    body = {
      error: {
        code: error instanceof CaptureRefusal ? error.code : 'VIEWPORT_CAPTURE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (signal.aborted) return;
  await fetch(`${SERVER_BASE}/viewport/frame/${encodeURIComponent(event.id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...serverAuthHeaders() },
    body: JSON.stringify(body),
  });
}

export function useViewportCapture(): void {
  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;
    const queue = createCaptureQueue();
    const inflight = new Map<string, AbortController>();

    const retry = (): void => {
      if (disposed || timer !== null) return;
      const delay = Math.min(RETRY_BASE_MS * pow(2, attempt), RETRY_MAX_MS);
      attempt += 1;
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay);
    };

    const open = (url: string): void => {
      if (disposed) return;
      const es = new EventSource(url);
      source = es;
      es.onopen = () => {
        attempt = 0;
      };
      es.addEventListener('capture', (e: Event) => {
        const event = parseEvent((e as MessageEvent<string>).data);
        if (event === null) return;
        const cancel = new AbortController();
        inflight.set(event.id, cancel);
        void queue
          .run(() => answer(event, cancel.signal), cancel.signal)
          .catch(() => undefined)
          .finally(() => inflight.delete(event.id));
      });
      es.addEventListener('cancel', (e: Event) => {
        try {
          const value: unknown = JSON.parse((e as MessageEvent<string>).data);
          if (isRecord(value) && typeof value['id'] === 'string') inflight.get(value['id'])?.abort();
        } catch {
          // malformed: ignore
        }
      });
      es.onerror = () => {
        es.close();
        retry();
      };
    };

    const connect = (): void => {
      // a ticket is single-use: every (re)connect mints a fresh one; without a token the backend answers 401 unless it was launched insecure
      if (!hasApiToken()) return open(`${SERVER_BASE}/viewport/stream`);
      ticketStreamUrl('/viewport/stream').then(open, () => retry());
    };

    connect();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      for (const cancel of inflight.values()) cancel.abort();
      source?.close();
    };
  }, []);
}
