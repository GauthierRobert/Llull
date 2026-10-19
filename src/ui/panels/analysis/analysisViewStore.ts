// What the Analysis panel shows on the model (UI-only, never a command): the open case, the "Show on model" toggle, the plotted result
// (field / load case / time / deformation / mode) and the painted-surface answer the 3D overlay and the legend read.

import { create } from 'zustand';
import type { ResultChoice } from './analysisFields';
import type { SurfaceView } from './surfaceData';

export type SurfaceFeed =
  | { readonly status: 'idle'; readonly reason: string }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly surface: SurfaceView }
  | { readonly status: 'refused'; readonly reason: string };

interface AnalysisViewState extends ResultChoice {
  /** Case drawn on the model; null while the Analysis panel is closed. */
  analysisId: string | null;
  showOnModel: boolean;
  surface: SurfaceFeed;
  setActive(analysisId: string | null): void;
  setShowOnModel(show: boolean): void;
  setField(field: string): void;
  setLoadCase(loadCase: string): void;
  setTime(time: string): void;
  setScale(scale: string): void;
  setMode(mode: number): void;
  setSurface(surface: SurfaceFeed): void;
}

const NO_FEED: SurfaceFeed = { status: 'idle', reason: '' };

export const useAnalysisViewStore = create<AnalysisViewState>()((set, get) => ({
  analysisId: null,
  showOnModel: true,
  field: null,
  loadCase: '',
  time: '',
  scale: '',
  mode: 1,
  surface: NO_FEED,
  setActive: (analysisId) => {
    if (get().analysisId === analysisId) return;
    set({ analysisId, field: null, loadCase: '', time: '', scale: '', mode: 1, surface: NO_FEED });
  },
  setShowOnModel: (showOnModel) => set({ showOnModel }),
  setField: (field) => set({ field }),
  setLoadCase: (loadCase) => set({ loadCase }),
  setTime: (time) => set({ time }),
  setScale: (scale) => set({ scale }),
  setMode: (mode) => set({ mode }),
  setSurface: (surface) => set({ surface }),
}));
