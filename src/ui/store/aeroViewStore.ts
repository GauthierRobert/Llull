// What the Aerodynamics panel draws on the model (UI-only, not persisted): the panel publishes its latest body / airfoil results here, the
// 3D and 2D overlays read them. Cleared when the panel closes so stale numbers never linger on the design.

import { create } from 'zustand';
import type { Vec2, Vec3 } from '@core/model/types';
import type { Bounds } from '@core/geometry/bounds';

export interface AeroBodyView {
  /** Unit flow direction (air relative to the body). */
  readonly flow: Vec3;
  readonly bounds: Bounds;
  readonly frontalAreaM2: number;
  readonly dragN: number | null;
  readonly dynamicPressurePa: number | null;
}

export interface AeroAirfoilView {
  readonly entityId: string;
  readonly position: Vec3;
  readonly rotation: Vec3;
  /** Outline vertices in the entity's local frame and the Cp at each. */
  readonly points: ReadonlyArray<Vec2>;
  readonly pressures: readonly number[];
  readonly cpMin: number;
  readonly cpMax: number;
  readonly chord: number;
  readonly cl: number;
  readonly alphaDeg: number;
}

interface AeroViewState {
  shown: boolean;
  body: AeroBodyView | null;
  airfoil: AeroAirfoilView | null;
  setShown(shown: boolean): void;
  publish(body: AeroBodyView | null, airfoil: AeroAirfoilView | null): void;
}

export const useAeroViewStore = create<AeroViewState>()((set) => ({
  shown: true,
  body: null,
  airfoil: null,
  setShown: (shown) => set({ shown }),
  publish: (body, airfoil) => set({ body, airfoil }),
}));
