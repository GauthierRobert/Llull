// Review overlays of the wrap results (03 WRP, UI-only, not persisted, never a command): which layers of `wrap_overlay` are drawn.

import { create } from 'zustand';

export type WrapLayer = 'curves' | 'edges';

export const WRAP_LAYERS: ReadonlyArray<{ value: WrapLayer; label: string; title: string }> = [
  {
    value: 'curves',
    label: 'Curves on faces',
    title: 'The curves lying on a face: wrapped, projected and silhouette curves (orange; those of an earlier solid, a split, in yellow)',
  },
  {
    value: 'edges',
    label: 'Face joins',
    title:
      'The edges of the solid by what a chain of faces does across them: smooth green (the sketch develops across), convex orange and concave blue (mitred between two planes), unknown grey',
  },
];

interface WrapOverlayState {
  /** The master switch: nothing is drawn (and nothing is queried) while it is off. */
  enabled: boolean;
  layers: Readonly<Record<WrapLayer, boolean>>;
  setEnabled(enabled: boolean): void;
  setLayer(layer: WrapLayer, on: boolean): void;
}

export const useWrapOverlayStore = create<WrapOverlayState>()((set) => ({
  enabled: false,
  layers: { curves: true, edges: true },
  setEnabled: (enabled) => set({ enabled }),
  setLayer: (layer, on) => set((state) => ({ layers: { ...state.layers, [layer]: on } })),
}));
