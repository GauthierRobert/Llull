// What the Flow panel shows on the model (UI-only, never a command, not persisted): the open case, the layer switches and the decoded
// slice / streamline files the 3D overlay and the legend draw. The panel fills the feeds from the transports; closing it clears them.

import { create } from 'zustand';
import type { SliceFile, StreamlinesFile } from '@aero/index';

export type LayerFeed<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'refused'; readonly reason: string };

export interface SliceLayer {
  readonly caseId: string;
  /** Hash of the recorded result the file was sampled from: a layer is dropped when the case records another. */
  readonly resultsHash: string;
  readonly file: SliceFile;
}

export interface StreamlinesLayer {
  readonly caseId: string;
  readonly resultsHash: string;
  readonly file: StreamlinesFile;
  /** The transport's one-line summary (seed count, lengths, stops). */
  readonly summary: string;
}

export type FlowSolveState =
  | { readonly status: 'idle' }
  | {
      readonly status: 'running';
      /** `Date.now()` when the solve started: elapsed time is derived from it, so it stays right while the panel is closed. */ readonly startedAt: number;
      readonly gridStudy: boolean;
    }
  | { readonly status: 'done'; readonly summary: string }
  | { readonly status: 'cancelled'; readonly summary: string }
  | { readonly status: 'failed'; readonly summary: string; readonly code: string | null; readonly remediation: string }
  | { readonly status: 'missing'; readonly reason: string };

/** Run state of one case's solve and the answer of its last `cfd_stop`; kept here so it survives selecting another case or closing the panel. */
export interface FlowSolveEntry {
  readonly state: FlowSolveState;
  readonly stopNote: string;
}

const NO_SOLVE: FlowSolveEntry = { state: { status: 'idle' }, stopNote: '' };

interface FlowViewState {
  /** Solve state by case id. */
  solves: Readonly<Record<string, FlowSolveEntry>>;
  setSolve(caseId: string, entry: Partial<FlowSolveEntry>): void;
  /** Forgets the solve state of every case not in `caseIds` (deleted cases). */
  pruneSolves(caseIds: readonly string[]): void;
  /** Case drawn on the model; null while the Flow panel is closed. */
  caseId: string | null;
  showSlice: boolean;
  showStreamlines: boolean;
  slice: LayerFeed<SliceLayer>;
  streamlines: LayerFeed<StreamlinesLayer>;
  setCase(caseId: string | null): void;
  setShowSlice(show: boolean): void;
  setShowStreamlines(show: boolean): void;
  setSlice(feed: LayerFeed<SliceLayer>): void;
  setStreamlines(feed: LayerFeed<StreamlinesLayer>): void;
}

const IDLE = { status: 'idle' } as const;

export const useFlowViewStore = create<FlowViewState>()((set, get) => ({
  solves: {},
  pruneSolves: (caseIds) =>
    set((state) => {
      const kept = Object.entries(state.solves).filter(([id]) => caseIds.includes(id));
      return kept.length === Object.keys(state.solves).length ? state : { solves: Object.fromEntries(kept) };
    }),
  setSolve: (caseId, entry) =>
    set((state) => ({ solves: { ...state.solves, [caseId]: { ...(state.solves[caseId] ?? NO_SOLVE), ...entry } } })),
  caseId: null,
  showSlice: true,
  showStreamlines: true,
  slice: IDLE,
  streamlines: IDLE,
  setCase: (caseId) => {
    if (get().caseId !== caseId) set({ caseId, slice: IDLE, streamlines: IDLE });
  },
  setShowSlice: (showSlice) => set({ showSlice }),
  setShowStreamlines: (showStreamlines) => set({ showStreamlines }),
  setSlice: (slice) => set({ slice }),
  setStreamlines: (streamlines) => set({ streamlines }),
}));
