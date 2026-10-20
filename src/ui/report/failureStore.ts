/**
 * The last internal command failure (SC-A4) and whether its report dialog is open. Presentation state only: a user error or a
 * "not supported" notice never lands here, and a later successful command or summary hides the offer (the status bar compares summaries).
 */
import { create } from 'zustand';
import type { DispatchOptions } from '@ui/store/storeTypes';
import { classifyFailure } from './classifyFailure';

export interface CommandFailure {
  readonly name: string;
  readonly params: unknown;
  readonly summary: string;
  /** `Date.now()` when the failure was reported (matches a backend crash report written just after it). */
  readonly at: number;
}

interface FailureState {
  failure: CommandFailure | null;
  dialogOpen: boolean;
  recordFailure(failure: CommandFailure): void;
  openDialog(): void;
  closeDialog(): void;
}

export const useFailureStore = create<FailureState>()((set) => ({
  failure: null,
  dialogOpen: false,
  recordFailure: (failure) => set({ failure }),
  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),
}));

/** `options` with an `onResult` that also records an internal failure of THIS dispatch; the caller's own `onResult` still runs. */
export function withFailureTracking(name: string, params: unknown, options: DispatchOptions | undefined): DispatchOptions {
  return {
    ...options,
    onResult: (result) => {
      if (!result.changed && classifyFailure(result.summary) === 'internal') {
        useFailureStore.getState().recordFailure({ name, params, summary: result.summary, at: Date.now() });
      }
      options?.onResult?.(result);
    },
  };
}
