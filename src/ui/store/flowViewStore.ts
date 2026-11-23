// What the Flow panel shows on the model (UI-only, never a command, not persisted): the open case, the layer switches and the decoded
// slice / streamline files the 3D overlay and the legend draw. The panel fills the feeds from the transports; closing it clears them.

import { create } from 'zustand';
import type { SliceFile, StreamlinesFile } from '@ui/viewport/3d/cfd/cfdFiles';

export type LayerFeed<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'refused'; readonly reason: string };

export interface SliceLayer {
  readonly caseId: string;
  readonly file: SliceFile;
}

export interface StreamlinesLayer {
  readonly caseId: string;
  readonly file: StreamlinesFile;
  /** The transport's one-line summary (seed count, lengths, stops). */
  readonly summary: string;
}

interface FlowViewState {
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
