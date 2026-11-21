/**
 * The request / response channel to the connected desktop renderer for `capture_viewport` (ASC M6a, D6). The renderer opens `GET /viewport/stream`
 * (SSE) once; the broker sends it `capture` events and the renderer answers each with `POST /viewport/frame/:id`.
 * @invariant a request goes to the most recently connected renderer; it ends with that renderer's frame or error, a timeout, the caller's abort, or the renderer leaving
 * @invariant an answer for an id nobody waits for (late, repeated, forged) is ignored
 */

import { randomUUID } from 'node:crypto';
import type { ViewportCaptureRequest } from '@core/model/viewportCapture';
import type { CapturedFrame } from '../native/deferredRun';

const DEFAULT_CAPTURE_TIMEOUT_MS = 10_000;

export type CaptureAnswer = CapturedFrame | { readonly code: string; readonly message: string };

export interface CaptureEvent {
  readonly id: string;
  readonly request: ViewportCaptureRequest;
}

interface Pending {
  readonly client: object;
  readonly settle: (answer: CaptureAnswer) => void;
}

const clients: { readonly id: object; readonly send: (event: CaptureEvent) => void }[] = [];
const pending = new Map<string, Pending>();

/** A renderer connected its stream; returns what to call when it leaves (its waiting requests end with VIEWPORT_UNAVAILABLE). */
export function registerRenderer(send: (event: CaptureEvent) => void): () => void {
  const id = {};
  clients.push({ id, send });
  return () => {
    const at = clients.findIndex((client) => client.id === id);
    if (at >= 0) clients.splice(at, 1);
    for (const waiting of [...pending.values()])
      if (waiting.client === id)
        waiting.settle({ code: 'VIEWPORT_UNAVAILABLE', message: 'the desktop viewport disconnected before it answered' });
  };
}

export const hasRenderer = (): boolean => clients.length > 0;

/** `LLULL_VIEWPORT_TIMEOUT_MS` (default 10000). */
export function captureTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env['LLULL_VIEWPORT_TIMEOUT_MS']);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CAPTURE_TIMEOUT_MS;
}

/** Ask the newest renderer for a frame; never rejects. */
export function requestFrame(request: ViewportCaptureRequest, signal: AbortSignal, timeoutMs: number): Promise<CaptureAnswer> {
  const client = clients[clients.length - 1];
  if (client === undefined) return Promise.resolve({ code: 'VIEWPORT_UNAVAILABLE', message: 'no desktop viewport is connected' });
  return new Promise<CaptureAnswer>((resolve) => {
    const id = randomUUID();
    const done = (answer: CaptureAnswer): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      pending.delete(id);
      resolve(answer);
    };
    const onAbort = (): void => done({ code: 'MESH_CANCELLED', message: 'the capture was cancelled' });
    const timer = setTimeout(
      () => done({ code: 'VIEWPORT_TIMEOUT', message: `the desktop viewport did not answer within ${timeoutMs} ms` }),
      timeoutMs,
    );
    timer.unref();
    pending.set(id, { client: client.id, settle: done });
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    client.send({ id, request });
  });
}

/** The renderer's answer to request `id`; false when nobody waits for it. */
export function answerFrame(id: string, answer: CaptureAnswer): boolean {
  const waiting = pending.get(id);
  if (waiting === undefined) return false;
  waiting.settle(answer);
  return true;
}
