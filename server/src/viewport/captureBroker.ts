/**
 * The request / response channel to the connected desktop renderer for `capture_viewport` (ASC M6a, D6). The renderer opens `GET /viewport/stream`
 * (SSE) once; the broker sends it `capture` events and the renderer answers each with `POST /viewport/frame/:id`.
 * @invariant a request goes to the most recently connected renderer; it ends with that renderer's frame or error, a timeout, the caller's abort, or no renderer left
 * @invariant when the renderer holding a request leaves, the request moves to the next connected renderer (resent), else it ends VIEWPORT_UNAVAILABLE
 * @invariant a timeout or an abort tells the renderer (`cancel { id }`) so it drops the frame it has not drawn yet
 * @invariant an answer for an id nobody waits for (late, repeated, forged) is ignored
 */

import { randomUUID } from 'node:crypto';
import type { ViewportCaptureRequest } from '@core/model/viewportCapture';
import type { CapturedFrame } from '../native/deferredRun';

const DEFAULT_CAPTURE_TIMEOUT_MS = 10_000;

export type CaptureAnswer = CapturedFrame | { readonly code: string; readonly message: string };

/** What the renderer is asked: draw `request` once its document has the content hash `documentHash` (VIEWPORT_STALE when it never does). */
export interface CaptureEvent {
  readonly id: string;
  readonly request: ViewportCaptureRequest;
  readonly documentHash: string;
}

export type RendererMessage = { readonly type: 'capture'; readonly event: CaptureEvent } | { readonly type: 'cancel'; readonly id: string };

interface Client {
  readonly id: object;
  readonly send: (message: RendererMessage) => void;
}

interface Pending {
  client: Client;
  readonly event: CaptureEvent;
  readonly settle: (answer: CaptureAnswer) => void;
}

const clients: Client[] = [];
const pending = new Map<string, Pending>();

/** A renderer connected its stream; returns what to call when it leaves (its waiting requests move to the next renderer, or end VIEWPORT_UNAVAILABLE). */
export function registerRenderer(send: (message: RendererMessage) => void): () => void {
  const self: Client = { id: {}, send };
  clients.push(self);
  return () => {
    const at = clients.indexOf(self);
    if (at >= 0) clients.splice(at, 1);
    const next = clients[clients.length - 1];
    for (const waiting of [...pending.values()]) {
      if (waiting.client !== self) continue;
      if (next === undefined)
        waiting.settle({ code: 'VIEWPORT_UNAVAILABLE', message: 'the desktop viewport disconnected before it answered' });
      else {
        waiting.client = next;
        next.send({ type: 'capture', event: waiting.event });
      }
    }
  };
}

export const hasRenderer = (): boolean => clients.length > 0;

/** `LLULL_VIEWPORT_TIMEOUT_MS` (default 10000). */
export function captureTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env['LLULL_VIEWPORT_TIMEOUT_MS']);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CAPTURE_TIMEOUT_MS;
}

/** Ask the newest renderer for a frame of the document with content hash `documentHash`; never rejects. */
export function requestFrame(
  request: ViewportCaptureRequest,
  documentHash: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<CaptureAnswer> {
  const client = clients[clients.length - 1];
  if (client === undefined) return Promise.resolve({ code: 'VIEWPORT_UNAVAILABLE', message: 'no desktop viewport is connected' });
  return new Promise<CaptureAnswer>((resolve) => {
    const event: CaptureEvent = { id: randomUUID(), request, documentHash };
    const done = (answer: CaptureAnswer, tellRenderer: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const waiting = pending.get(event.id);
      pending.delete(event.id);
      if (tellRenderer && waiting !== undefined) waiting.client.send({ type: 'cancel', id: event.id });
      resolve(answer);
    };
    const onAbort = (): void => done({ code: 'VIEWPORT_CANCELLED', message: 'the capture was cancelled' }, true);
    const timer = setTimeout(
      () => done({ code: 'VIEWPORT_TIMEOUT', message: `the desktop viewport did not answer within ${timeoutMs} ms` }, true),
      timeoutMs,
    );
    timer.unref();
    pending.set(event.id, { client, event, settle: (answer) => done(answer, false) });
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    client.send({ type: 'capture', event });
  });
}

/** The request waiting under `id`, or undefined (late, repeated, forged). */
export function pendingRequest(id: string): ViewportCaptureRequest | undefined {
  return pending.get(id)?.event.request;
}

/** The renderer's answer to request `id`; false when nobody waits for it. */
export function answerFrame(id: string, answer: CaptureAnswer): boolean {
  const waiting = pending.get(id);
  if (waiting === undefined) return false;
  waiting.settle(answer);
  return true;
}
