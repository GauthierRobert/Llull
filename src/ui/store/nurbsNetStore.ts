// Control polygon / net overlay of NURBS entities (VC-37), UI-only: whether the poles are shown, the pole under the pointer, the selected poles with
// their soft-selection falloff, the marquee in flight and the pole drag in flight with the dry-run entity it produces. The document changes only when
// a drag commits ONE command through `dispatch`.

import { create } from 'zustand';
import type { NurbsCurveEntity, NurbsSurfaceEntity, Vec3 } from '@core/model/types';
import { type PoleFalloff, type PoleId, samePole } from '@ui/viewport/3d/nurbsNet/controlNet';

interface PoleDrag {
  readonly entityId: string;
  readonly pole: PoleId;
  /** World displacement so far. */
  readonly delta: Vec3;
  /** The entity as the commit would store it (null while the dry run is refused or pending). */
  readonly preview: NurbsCurveEntity | NurbsSurfaceEntity | null;
}

/** The selection rectangle in client pixels while a box selection is dragged. */
export interface Marquee {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

interface NurbsNetState {
  visible: boolean;
  hover: PoleId | null;
  /** The poles a drag moves (all of them at once) when the grabbed pole belongs to it. */
  selected: readonly PoleId[];
  falloff: PoleFalloff;
  marquee: Marquee | null;
  drag: PoleDrag | null;
  toggle(): void;
  setHover(hover: PoleId | null): void;
  setSelected(selected: readonly PoleId[]): void;
  setFalloff(falloff: Partial<PoleFalloff>): void;
  setMarquee(marquee: Marquee | null): void;
  setDrag(drag: PoleDrag | null): void;
}

export const useNurbsNetStore = create<NurbsNetState>()((set) => ({
  visible: false,
  hover: null,
  selected: [],
  falloff: { radius: 0, shape: 'smooth' },
  marquee: null,
  drag: null,
  toggle: () => set((state) => ({ visible: !state.visible, hover: null, drag: null, selected: [], marquee: null })),
  setHover: (hover) =>
    set((state) => (state.hover === hover || (state.hover !== null && hover !== null && samePole(state.hover, hover)) ? state : { hover })),
  setSelected: (selected) => set({ selected }),
  setFalloff: (falloff) => set((state) => ({ falloff: { ...state.falloff, ...falloff } })),
  setMarquee: (marquee) => set({ marquee }),
  setDrag: (drag) => set({ drag }),
}));
