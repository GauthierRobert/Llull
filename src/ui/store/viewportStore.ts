/**
 * @layer ui/store
 *
 * Render-only viewport presentation state — NOT part of CadDocument.
 *
 * Tracks:
 *   - `displayMode` — shaded / wireframe / x-ray render mode.
 *   - `clipPlane`   — optional axis-aligned section plane for revealing solid interiors.
 *   - `hiddenEntityIds` — entity ids suppressed from the 3D render (UI-only visibility override).
 *   - `qualityOverride` — user-selected render quality tier (or 'auto' to derive from entity count).
 *   - `animationPlaying` — global play/pause for `trigger:'auto'` animations.
 *   - `activeClickAnimationIds` — set of `trigger:'click'` animation ids currently toggled on.
 *   - `animationResetNonce` — bumped by `resetAnimations()` to tell the player to zero its phase accumulators.
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

/**
 * Render quality tier — controls shadow map resolution, PCSS sample count,
 * and contact-shadow presence. 'auto' derives the tier from entity count.
 *
 * Thresholds (entity count from document.order.length):
 *   High   : ≤ 50   — PCSS 16 samples, 2048² shadow map, ContactShadows on.
 *   Medium : 51–200 — PCSS 8 samples, 1024² shadow map, ContactShadows on.
 *   Low    : > 200  — SoftShadows off, 1024² shadow map, ContactShadows off.
 */
export type QualityTier = 'high' | 'medium' | 'low';

/** User choice: explicit tier or 'auto' (derive from entity count). */
export type QualityOverride = QualityTier | 'auto';

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

/** Identifies a selected mechanism item for overlay rendering. */
export type MechanismSelectionKind = 'constraint' | 'joint';

/** Currently highlighted constraint or joint in the MechanismsPanel. */
export interface MechanismSelection {
  kind: MechanismSelectionKind;
  id: string;
}

export interface ViewportStoreState {
  /** Active render style for all 3D solid entities. Default: 'shaded'. */
  displayMode: DisplayMode;

  /** Section plane configuration. */
  clipPlane: ClipPlaneState;

  /** Set of entity ids suppressed from the 3D render. Never touches the document. */
  hiddenEntityIds: ReadonlySet<EntityId>;

  /**
   * Set of layer ids locally hidden from the viewport.
   * This is a pure render override — it does NOT dispatch set_layer_visibility
   * and does NOT touch the server document. A local viewer convenience.
   */
  hiddenLayerIds: ReadonlySet<string>;

  /**
   * User-selected quality override. Default: 'auto'.
   * 'auto' derives the tier from document.order.length via deriveQualityTier().
   * Explicit values pin the tier regardless of entity count.
   * Stored as a viewer preference — never serialised into CadDocument.
   */
  qualityOverride: QualityOverride;

  /**
   * Whether 3D object snapping is active during gizmo translate drags.
   * Render-only flag — never serialised into CadDocument.
   * Default: true.
   */
  snap3dEnabled: boolean;

  // ---- Animation runtime state -------------------------------------------

  /**
   * Global play/pause for `trigger:'auto'` animations.
   * `trigger:'click'` animations are controlled independently via `activeClickAnimationIds`.
   * Default: false.
   */
  animationPlaying: boolean;

  /**
   * Set of animation ids (whose `trigger === 'click'`) that are currently toggled ON.
   * A click on a target entity adds/removes its animation ids from this set.
   * Render-only — never serialised into CadDocument.
   */
  activeClickAnimationIds: ReadonlySet<string>;

  /**
   * Bumped by `resetAnimations()` to signal the AnimationPlayer to zero all
   * phase accumulators on the next frame. An incrementing integer is used so
   * any subscriber can detect the bump with a simple reference comparison.
   * Default: 0.
   */
  animationResetNonce: number;

  /**
   * Currently highlighted mechanism item (constraint or joint) for the 3D overlay.
   * Null when no mechanism item is selected in the panel.
   * UI-only state — never serialised into CadDocument.
   */
  mechanismSelection: MechanismSelection | null;

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

  /**
   * Toggle a layer's local viewport visibility.
   * Does NOT dispatch any command — purely a render-side filter.
   */
  toggleLayerVisibility(layerId: string): void;

  /** Toggle 3D object snapping on/off. */
  toggleSnap3d(): void;

  /** Set the quality override ('high' | 'medium' | 'low' | 'auto'). */
  setQualityOverride(quality: QualityOverride): void;

  // ---- Animation actions -------------------------------------------------

  /** Toggle global animation playback (Play ↔ Pause for `trigger:'auto'` animations). */
  toggleAnimationPlaying(): void;

  /** Explicitly set global animation playback state. */
  setAnimationPlaying(playing: boolean): void;

  /**
   * Stop playback, clear all active click animations, and bump the reset nonce
   * so the AnimationPlayer zeroes all phase accumulators on the next frame.
   */
  resetAnimations(): void;

  /**
   * Add or remove an animation id from `activeClickAnimationIds`.
   * If the id is already in the set it is removed (toggle off); otherwise it is added (toggle on).
   */
  toggleClickAnimation(animId: string): void;

  /**
   * Set the highlighted mechanism item (constraint/joint) for the 3D overlay.
   * Pass null to clear the selection.
   */
  setMechanismSelection(selection: MechanismSelection | null): void;
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
  hiddenLayerIds: new Set<string>(),
  snap3dEnabled: true,
  qualityOverride: 'auto',

  // Animation runtime defaults
  animationPlaying: false,
  activeClickAnimationIds: new Set<string>(),
  animationResetNonce: 0,

  mechanismSelection: null,

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

  toggleLayerVisibility(layerId: string): void {
    set((state) => {
      const next = new Set(state.hiddenLayerIds);
      if (next.has(layerId)) {
        next.delete(layerId);
      } else {
        next.add(layerId);
      }
      return { hiddenLayerIds: next };
    });
  },

  toggleSnap3d(): void {
    set((state) => ({ snap3dEnabled: !state.snap3dEnabled }));
  },

  setQualityOverride(quality: QualityOverride): void {
    set({ qualityOverride: quality });
  },

  // ---- Animation actions -------------------------------------------------

  toggleAnimationPlaying(): void {
    set((state) => ({ animationPlaying: !state.animationPlaying }));
  },

  setAnimationPlaying(playing: boolean): void {
    set({ animationPlaying: playing });
  },

  resetAnimations(): void {
    set((state) => ({
      animationPlaying: false,
      activeClickAnimationIds: new Set<string>(),
      animationResetNonce: state.animationResetNonce + 1,
    }));
  },

  toggleClickAnimation(animId: string): void {
    set((state) => {
      const next = new Set(state.activeClickAnimationIds);
      if (next.has(animId)) {
        next.delete(animId);
      } else {
        next.add(animId);
      }
      return { activeClickAnimationIds: next };
    });
  },

  setMechanismSelection(selection: MechanismSelection | null): void {
    set({ mechanismSelection: selection });
  },
}));
