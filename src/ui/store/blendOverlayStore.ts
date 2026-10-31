// Review overlay of the blends (06 BLD M5, UI-only, not persisted, never a command): which layers of `blend_overlay` are drawn.

import { create } from 'zustand';

export type BlendLayer = 'contacts' | 'junctions' | 'corners' | 'chamfers';

export const BLEND_LAYERS: ReadonlyArray<{ value: BlendLayer; label: string; title: string }> = [
  {
    value: 'contacts',
    label: 'Contacts',
    title: 'Where each fillet face meets a support face, coloured by what check_blends measured (G0 gap, G1 angle)',
  },
  {
    value: 'junctions',
    label: 'Junctions',
    title: 'Where one blend face meets the next of its tangent chain, with a marker at the middle',
  },
  {
    value: 'corners',
    label: 'Corner patches',
    title: 'The outlines of setback corner patches: exact star or plate patch (a warning or failure shows in its status colour)',
  },
  {
    value: 'chamfers',
    label: 'Chamfer legs',
    title: 'The contact lines of variable and asymmetric chamfers, coloured by the leg readback',
  },
];

interface BlendOverlayState {
  /** The master switch: nothing is drawn (and nothing is queried) while it is off. */
  enabled: boolean;
  layers: Readonly<Record<BlendLayer, boolean>>;
  /** What each drawn solid has to say (counts, the first failing finding, why nothing could be read): the status line under the layer switches. */
  status: Readonly<Record<string, readonly string[]>>;
  setStatus(id: string, lines: readonly string[]): void;
  setEnabled(enabled: boolean): void;
  setLayer(layer: BlendLayer, on: boolean): void;
}

export const useBlendOverlayStore = create<BlendOverlayState>()((set) => ({
  enabled: false,
  layers: { contacts: true, junctions: true, corners: true, chamfers: true },
  status: {},
  setStatus: (id, lines) =>
    set((state) => {
      const { [id]: _previous, ...rest } = state.status;
      return { status: lines.length === 0 ? rest : { ...rest, [id]: lines } };
    }),
  setEnabled: (enabled) => set({ enabled }),
  setLayer: (layer, on) => set((state) => ({ layers: { ...state.layers, [layer]: on } })),
}));
