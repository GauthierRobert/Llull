// Surface-analysis overlays drawn on the model (UI-only, not persisted, never a command): a colour map on nurbs_surface sheets and the
// curvature comb on nurbs_curve entities. The numbers come from @core/geometry/surfaceAnalysis/overlay (the analysis commands' own maths).

import { create } from 'zustand';
import type { Vec3 } from '@core/model/types';
import type { SurfaceMapMode } from '@core/geometry/surfaceAnalysis/overlay';

export type SurfaceMapChoice = 'off' | SurfaceMapMode;

interface SurfaceOverlayState {
  /** Colour map on every nurbs_surface; 'off' draws the plain sheet. */
  map: SurfaceMapChoice;
  /** Curvature comb on every nurbs_curve. */
  comb: boolean;
  /** Zebra light direction / draft pull direction. */
  direction: Vec3;
  setMap(map: SurfaceMapChoice): void;
  setComb(comb: boolean): void;
  setDirection(direction: Vec3): void;
}

export const useSurfaceOverlayStore = create<SurfaceOverlayState>()((set) => ({
  map: 'off',
  comb: false,
  direction: [0, 0, 1],
  setMap: (map) => set({ map }),
  setComb: (comb) => set({ comb }),
  setDirection: (direction) => set({ direction }),
}));
