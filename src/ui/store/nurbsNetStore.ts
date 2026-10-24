// Control polygon / net overlay of NURBS entities (VC-37), UI-only: whether the poles are shown, the pole under the pointer and the pole drag in
// flight with the dry-run entity it produces. The document changes only when a drag commits ONE command through `dispatch`.

import { create } from 'zustand';
import type { NurbsCurveEntity, NurbsSurfaceEntity, Vec3 } from '@core/model/types';
import type { PoleId } from '@ui/viewport/3d/nurbsNet/controlNet';

interface PoleDrag {
  readonly entityId: string;
  readonly pole: PoleId;
  /** World displacement so far. */
  readonly delta: Vec3;
  /** The entity as the commit would store it (null while the dry run is refused or pending). */
  readonly preview: NurbsCurveEntity | NurbsSurfaceEntity | null;
}

interface NurbsNetState {
  visible: boolean;
  hover: PoleId | null;
  drag: PoleDrag | null;
  toggle(): void;
  setHover(hover: PoleId | null): void;
  setDrag(drag: PoleDrag | null): void;
}

const same = (a: PoleId | null, b: PoleId | null): boolean =>
  a === b || (a !== null && b !== null && typeof a !== 'number' && typeof b !== 'number' && a[0] === b[0] && a[1] === b[1]);

export const useNurbsNetStore = create<NurbsNetState>()((set) => ({
  visible: false,
  hover: null,
  drag: null,
  toggle: () => set((state) => ({ visible: !state.visible, hover: null, drag: null })),
  setHover: (hover) => set((state) => (same(state.hover, hover) ? state : { hover })),
  setDrag: (drag) => set({ drag }),
}));
