/**
 * The renderer's end of `capture_viewport` (ASC M6a): holds `GET <SERVER_BASE>/viewport/stream` (SSE, ticket auth) open and answers each `capture`
 * event with a frame (`POST /viewport/frame/:id`) drawn by the mounted 3D canvas (`CaptureRig`), or with the reason it could not.
 * onerror: reconnect with a fresh ticket (1s..30s backoff).
 */

import { useEffect } from 'react';
import type { ViewportCaptureRequest } from '@core/model/viewportCapture';
import { uint8ArrayToBase64 } from '@lib/base64';
import { isRecord } from '@lib/isRecord';
import { pow } from '@lib/pow';
import { SERVER_BASE, hasApiToken, serverAuthHeaders, ticketStreamUrl } from '@ui/serverConfig';
import { captureFrame } from '@ui/viewport/3d/capture/captureRegistry';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;

interface CaptureEvent {
  readonly id: string;
  readonly request: ViewportCaptureRequest;
}

function parseEvent(raw: string): CaptureEvent | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) && typeof value['id'] === 'string' && isRecord(value['request']) ? (value as unknown as CaptureEvent) : null;
  } catch {
    return null;
  }
}

async function answer(event: CaptureEvent): Promise<void> {
  let body: Record<string, unknown>;
  try {
    const frame = await captureFrame(event.request);
    body = { png: uint8ArrayToBase64(frame.png), width: frame.width, height: frame.height };
  } catch (error) {
    body = { error: { code: 'VIEWPORT_CAPTURE_FAILED', message: error instanceof Error ? error.message : String(error) } };
  }
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
        if (event !== null) void answer(event).catch(() => undefined);
      });
      es.onerror = () => {
        es.close();
        retry();
      };
    };

    const connect = (): void => {
      // a ticket is single-use: every (re)connect mints a fresh one
      ticketStreamUrl('/viewport/stream').then(open, () => retry());
    };

    if (hasApiToken()) connect();
    else open(`${SERVER_BASE}/viewport/stream`);
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      source?.close();
    };
  }, []);
}
