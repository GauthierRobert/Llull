// Debounced, cancellable preview of a command with changing params. Nothing here mutates the document: `request` only runs
// `run` (a pure dry run) and reports the outcome; `commit` is the ONLY path that calls `dispatch`, exactly once.

import type { CadDocument } from '@core/model/types';
import type { DispatchOptions } from '@ui/store/storeTypes';
import type { PreviewOutcome } from './runPreview';

export const PREVIEW_DEBOUNCE_MS = 120;

export interface PreviewControllerDeps {
  getDocument(): CadDocument;
  run(doc: CadDocument, name: string, params: unknown): PreviewOutcome;
  dispatch(name: string, params: unknown, options?: DispatchOptions): void;
  /** Receives each fresh outcome; null clears the preview. */
  onOutcome(outcome: PreviewOutcome | null): void;
  delayMs?: number;
}

export interface PreviewController {
  /** Schedule a preview; a newer request (or cancel / commit) discards this one if it has not run yet. */
  request(name: string, params: unknown): void;
  /** Drop any pending run and clear the ghost. */
  cancel(): void;
  /** Clear the ghost and dispatch the real command once. */
  commit(name: string, params: unknown, options?: DispatchOptions): void;
}

export function createPreviewController(deps: PreviewControllerDeps): PreviewController {
  const delay = deps.delayMs ?? PREVIEW_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  const discardPending = (): void => {
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return {
    request(name, params): void {
      discardPending();
      const mine = generation;
      timer = setTimeout(() => {
        timer = null;
        if (mine !== generation) return;
        deps.onOutcome(deps.run(deps.getDocument(), name, params));
      }, delay);
    },
    cancel(): void {
      discardPending();
      deps.onOutcome(null);
    },
    commit(name, params, options): void {
      discardPending();
      deps.onOutcome(null);
      deps.dispatch(name, params, options);
    },
  };
}
