// Review overlays of deformed bodies (01 DEF M4, UI-only, not persisted, never a command): which layers of `deform_overlay` are drawn, and the
// reference shape to compare with (the text the user typed; `referenceParams` turns it into the compareTo parameter once it is complete).

import { create } from 'zustand';

export type DeformLayer = 'frame' | 'region' | 'lattice' | 'flow' | 'sheet' | 'reference';

export const DEFORM_LAYERS: ReadonlyArray<{ value: DeformLayer; label: string; title: string }> = [
  { value: 'frame', label: 'Frame', title: 'The deformation frame: x red, y green, z (the axis) blue' },
  {
    value: 'region',
    label: 'Region',
    title: 'The slab the law acts on: planes at the region ends; an infinite region is drawn with its axis extended past both ends',
  },
  {
    value: 'lattice',
    label: 'Lattice',
    title: 'The lattice net at rest (grey) and displaced (orange) and its box; B-spline and oriented lattices too',
  },
  { value: 'flow', label: 'Curves', title: 'flow_along_curve: the target curve (green) and the base curve (cyan)' },
  { value: 'sheet', label: 'Sheets', title: 'flow_on_surface: the target sheet nodes (green) and the base sheet (cyan)' },
  { value: 'reference', label: 'Reference', title: 'The analytic reference shape of the comparison, drawn as a wire' },
];

/** What the user typed for the reference shape: the kind and the text of each field. */
export interface ReferenceDraft {
  readonly kind: string;
  readonly fields: Readonly<Record<string, string>>;
}

interface DeformOverlayState {
  /** The master switch: nothing is drawn (and nothing is queried) while it is off. */
  enabled: boolean;
  layers: Readonly<Record<DeformLayer, boolean>>;
  reference: ReferenceDraft | null;
  setEnabled(enabled: boolean): void;
  setLayer(layer: DeformLayer, on: boolean): void;
  setReference(reference: ReferenceDraft | null): void;
}

export const useDeformOverlayStore = create<DeformOverlayState>()((set) => ({
  enabled: false,
  layers: { frame: true, region: true, lattice: true, flow: true, sheet: true, reference: true },
  reference: null,
  setEnabled: (enabled) => set({ enabled }),
  setLayer: (layer, on) => set((state) => ({ layers: { ...state.layers, [layer]: on } })),
  setReference: (reference) => set({ reference }),
}));
