/**
 * @layer ui/store
 *
 * Render-only viewport presentation state — NOT part of CadDocument.
 *
 * PRIME DIRECTIVE: no document mutations ever happen here. These are pure presentation/render
 * overrides; they are never serialised into CadDocument and never touch the command layer.
 */

import { create } from 'zustand';
import type { EntityId } from '@core/model/types';

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

interface ClipPlaneState {
  enabled: boolean;
  /** Axis the plane is normal to. Default: 'z' (horizontal cut, Z-up). */
  axis: ClipAxis;
  /** Signed offset along the axis in world units. */
  offset: number;
  /** When true the plane normal is flipped (cuts the other half). */
  flipped: boolean;
}

/** Currently highlighted constraint or joint in the MechanismsPanel. */
interface MechanismSelection {
  kind: 'constraint' | 'joint';
  id: string;
}

interface ViewportStoreState {
  displayMode: DisplayMode;
  clipPlane: ClipPlaneState;

  /** Entity ids suppressed from the 3D render. Never touches the document. */
  hiddenEntityIds: ReadonlySet<EntityId>;

  /**
   * Layer ids locally hidden from the viewport — a pure render override: it does NOT dispatch
   * set_layer_visibility and does NOT touch the server document.
   */
  hiddenLayerIds: ReadonlySet<string>;

  /** 'auto' derives the tier from document.order.length via deriveQualityTier(); explicit values pin it. */
  qualityOverride: QualityOverride;

  /** Whether 3D object snapping is active during gizmo translate drags. */
  snap3dEnabled: boolean;

  /** Global play/pause for `trigger:'auto'` animations. */
  animationPlaying: boolean;

  /** Ids of `trigger:'click'` animations currently toggled ON (a click on a target entity flips its ids). */
  activeClickAnimationIds: ReadonlySet<string>;

  /**
   * Bumped by `resetAnimations()` to signal the AnimationPlayer to zero all phase accumulators on
   * the next frame; an incrementing integer lets any subscriber detect the bump by comparison.
   */
  animationResetNonce: number;

  /** Highlighted mechanism item for the 3D overlay; null when none is selected in the panel. */
  mechanismSelection: MechanismSelection | null;

  setDisplayMode(mode: DisplayMode): void;

  /** Partial update; unchanged fields are preserved. */
  setClipPlane(patch: Partial<ClipPlaneState>): void;
  toggleClipPlane(): void;
  toggleEntityVisibility(id: EntityId): void;
  showAllEntities(): void;
  toggleLayerVisibility(layerId: string): void;
  toggleSnap3d(): void;
  setQualityOverride(quality: QualityOverride): void;
  toggleAnimationPlaying(): void;
  setAnimationPlaying(playing: boolean): void;

  /** Stop playback, clear active click animations and bump the reset nonce. */
  resetAnimations(): void;
  toggleClickAnimation(animId: string): void;
  setMechanismSelection(selection: MechanismSelection | null): void;
}

const DEFAULT_CLIP_PLANE: ClipPlaneState = {
  enabled: false,
  axis: 'z',
  offset: 0,
  flipped: false,
};

/** A copy of `members` with `member` removed if present, else added. */
function toggled<Member>(members: ReadonlySet<Member>, member: Member): Set<Member> {
  const next = new Set(members);
  if (!next.delete(member)) next.add(member);
  return next;
}

export const useViewportStore = create<ViewportStoreState>()((set) => ({
  displayMode: 'shaded',
  clipPlane: DEFAULT_CLIP_PLANE,
  hiddenEntityIds: new Set<EntityId>(),
  hiddenLayerIds: new Set<string>(),
  snap3dEnabled: true,
  qualityOverride: 'auto',

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
    set((state) => ({ hiddenEntityIds: toggled(state.hiddenEntityIds, id) }));
  },

  showAllEntities(): void {
    set({ hiddenEntityIds: new Set<EntityId>() });
  },

  toggleLayerVisibility(layerId: string): void {
    set((state) => ({ hiddenLayerIds: toggled(state.hiddenLayerIds, layerId) }));
  },

  toggleSnap3d(): void {
    set((state) => ({ snap3dEnabled: !state.snap3dEnabled }));
  },

  setQualityOverride(quality: QualityOverride): void {
    set({ qualityOverride: quality });
  },

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
    set((state) => ({ activeClickAnimationIds: toggled(state.activeClickAnimationIds, animId) }));
  },

  setMechanismSelection(selection: MechanismSelection | null): void {
    set({ mechanismSelection: selection });
  },
}));
