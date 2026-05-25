/**
 * @layer ui/store
 *
 * Render-only viewport presentation state — NOT part of CadDocument.
 *
 * Tracks:
 *   - `displayMode` — shaded / wireframe / x-ray render mode.
 *   - `clipPlane`   — optional axis-aligned section plane for revealing solid interiors.
 *   - `hiddenEntityIds` — entity ids suppressed from the 3D render (UI-only visibility override).
 *
 * PRIME DIRECTIVE: no document mutations ever happen here.
 * These are pure presentation/render overrides; they are never serialised
 * into CadDocument and never touch the command layer.
 */

import { create } from 'zustand';
import type { EntityId } from '@core/model/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How all solid surfaces are rendered in the 3D viewport. */
export type DisplayMode = 'shaded' | 'wireframe' | 'xray';

/** Which world axis the section plane is normal to. */
export type ClipAxis = 'x' | 'y' | 'z';

/** Section-plane state — all fields are render-only. */
export interface ClipPlaneState {
  /** Whether the clipping plane is active. */
  enabled: boolean;
  /** Axis the plane is normal to. Default: 'y' (horizontal cut). */
  axis: ClipAxis;
  /**
   * Signed offset along the axis in world units.
   * Positive = moved in the positive-axis direction.
   */
  offset: number;
  /** When true the plane normal is flipped (cuts the other half). */
  flipped: boolean;
}

// ---------------------------------------------------------------------------
// Store state
// ---------------------------------------------------------------------------

export interface ViewportStoreState {
  /** Active render style for all 3D solid entities. Default: 'shaded'. */
  displayMode: DisplayMode;

  /** Section plane configuration. */
  clipPlane: ClipPlaneState;

  /** Set of entity ids suppressed from the 3D render. Never touches the document. */
  hiddenEntityIds: ReadonlySet<EntityId>;

  // ---- Actions ------------------------------------------------------------

  /** Set the global display mode ('shaded' | 'wireframe' | 'xray'). */
  setDisplayMode(mode: DisplayMode): void;

  /** Update clip-plane fields (partial update; unchanged fields are preserved). */
  setClipPlane(patch: Partial<ClipPlaneState>): void;

  /** Toggle the clip plane on/off. */
  toggleClipPlane(): void;

  /**
   * Toggle a single entity's render-visibility.
   * Hidden → visible: removes from the set.
   * Visible → hidden: adds to the set.
   */
  toggleEntityVisibility(id: EntityId): void;

  /** Make all hidden entities visible again. */
  showAllEntities(): void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CLIP_PLANE: ClipPlaneState = {
  enabled: false,
  axis: 'y',
  offset: 0,
  flipped: false,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useViewportStore = create<ViewportStoreState>()((set) => ({
  displayMode: 'shaded',
  clipPlane: DEFAULT_CLIP_PLANE,
  hiddenEntityIds: new Set<EntityId>(),

  setDisplayMode(mode: DisplayMode): void {
    set({ displayMode: mode });
  },

  setClipPlane(patch: Partial<ClipPlaneState>): void {
    set((state) => ({ clipPlane: { ...state.clipPlane, ...patch } }));
  },

  toggleClipPlane(): void {
    set((state) => ({
      clipPlane: { ...state.clipPlane, enabled: !state.clipPlane.enabled },
    }));
  },

  toggleEntityVisibility(id: EntityId): void {
    set((state) => {
      const next = new Set(state.hiddenEntityIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { hiddenEntityIds: next };
    });
  },

  showAllEntities(): void {
    set({ hiddenEntityIds: new Set<EntityId>() });
  },
}));
