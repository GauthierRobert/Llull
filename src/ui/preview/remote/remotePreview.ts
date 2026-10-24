// Client of the backend dry run (`POST /preview`) for a drag in flight. Pure sequencing, no fetch and no store: the transport and the sinks are
// injected. Requests are debounced (with a max wait, so a long drag still previews while it moves), a newer request aborts the one in flight, and
// an answer that is no longer the latest is dropped. Nothing here writes a document: the commit is a separate `dispatch`.

import type { PreviewResponseBody } from '@protocol/preview';

/** Quiet time after the last drag move before the request goes out. */
export const REMOTE_PREVIEW_DEBOUNCE_MS = 70;
/** A drag that never pauses still asks for a preview at least this often. */
export const REMOTE_PREVIEW_MAX_WAIT_MS = 220;

export interface RemotePreviewDeps {
  /** Performs the request; must reject (with any error) when `signal` aborts. */
  post(name: string, params: unknown, signal: AbortSignal): Promise<PreviewResponseBody>;
  /** The latest request's answer (stale answers never arrive here). */
  onResult(body: PreviewResponseBody): void;
  /** The latest request failed (network, HTTP); an aborted request is not an error. */
  onError(message: string): void;
  /** A request has been scheduled or is in flight. */
  onPending?(): void;
  debounceMs?: number;
  maxWaitMs?: number;
  now?(): number;
}

export interface RemotePreview {
  /** Ask for the preview of `name` with `params`; replaces any earlier request, pending or in flight. */
  request(name: string, params: unknown): void;
  /** Drop the pending request, abort the one in flight and ignore its answer. */
  cancel(): void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createRemotePreview(deps: RemotePreviewDeps): RemotePreview {
  const debounce = deps.debounceMs ?? REMOTE_PREVIEW_DEBOUNCE_MS;
  const maxWait = deps.maxWaitMs ?? REMOTE_PREVIEW_MAX_WAIT_MS;
  const now = deps.now ?? ((): number => Date.now());
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstPendingAt: number | null = null;
  let controller: AbortController | null = null;

  const drop = (): void => {
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    firstPendingAt = null;
    controller?.abort();
    controller = null;
  };

  const send = (mine: number, name: string, params: unknown): void => {
    timer = null;
    firstPendingAt = null;
    const own = new AbortController();
    controller = own;
    deps.post(name, params, own.signal).then(
      (body) => {
        if (mine !== generation || own.signal.aborted) return;
        controller = null;
        deps.onResult(body);
      },
      (error: unknown) => {
        if (mine !== generation || own.signal.aborted) return;
        controller = null;
        deps.onError(messageOf(error));
      },
    );
  };

  return {
    request(name, params): void {
      const started = firstPendingAt ?? now();
      drop();
      firstPendingAt = started;
      const mine = generation;
      const wait = Math.max(0, Math.min(debounce, started + maxWait - now()));
      deps.onPending?.();
      timer = setTimeout(() => send(mine, name, params), wait);
    },
    cancel: drop,
  };
}
