// Native jobs of running commands, as the backend reports them over /live (`progress` events, `@protocol/liveSync`): UI-only, never in the document.
// An entry lives from its first `running` report until `ended`, or until the command's own `command` event arrives.

import { create } from 'zustand';
import type { LiveProgressEvent } from '@protocol/liveSync';
import { isCancellable } from './commandCancel';

export interface ActiveJob {
  /** The sender's command id, or the command name when it sent none. */
  readonly key: string;
  readonly command: string;
  readonly commandId: string | undefined;
  readonly op: string;
  readonly stage: string;
  readonly message: string;
  /** Share done (0 to 1), null before the job reported one. */
  readonly fraction: number | null;
  readonly etaMs: number | null;
  readonly elapsedMs: number;
  /** This client sent the command: Cancel aborts its request. */
  readonly cancellable: boolean;
}

interface JobProgressState {
  jobs: readonly ActiveJob[];
  apply(event: LiveProgressEvent): void;
  /** The command settled (its `command` event arrived). */
  finish(key: string): void;
  clear(): void;
}

export const useJobProgressStore = create<JobProgressState>()((set) => ({
  jobs: [],
  apply(event): void {
    const key = event.commandId ?? event.command;
    if (event.state === 'ended') return set((state) => ({ jobs: state.jobs.filter((job) => job.key !== key) }));
    const job: ActiveJob = {
      key,
      command: event.command,
      commandId: event.commandId,
      op: event.op,
      stage: event.stage,
      message: event.message,
      fraction: event.fraction,
      etaMs: event.etaMs,
      elapsedMs: event.elapsedMs,
      cancellable: isCancellable(event.commandId),
    };
    set((state) => ({ jobs: [...state.jobs.filter((other) => other.key !== key), job] }));
  },
  finish(key): void {
    set((state) => (state.jobs.some((job) => job.key === key) ? { jobs: state.jobs.filter((job) => job.key !== key) } : state));
  },
  clear(): void {
    set({ jobs: [] });
  },
}));
