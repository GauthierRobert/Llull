// Render-only viewport presentation state: never serialized into the CadDocument, never a command.

import { create } from 'zustand';
import type { EntityId } from '@core/model/types';
import { toggledInSet } from '@ui/toggleMember';

export type DisplayMode = 'shaded' | 'wireframe' | 'xray';
/** high ≤ 50 entities, medium ≤ 200, low beyond (useRenderQuality). */
export type QualityTier = 'high' | 'medium' | 'low';
export type QualityOverride = QualityTier | 'auto';
/** World axis the section plane is normal to. */
export type ClipAxis = 'x' | 'y' | 'z';

interface ClipPlaneState {
  enabled: boolean;
  axis: ClipAxis;
  /** Signed offset along the axis. */
  offset: number;
  /** Cuts the other half. */
  flipped: boolean;
}

interface MechanismSelection {
  kind: 'constraint' | 'joint';
  id: string;
}

interface ViewportStoreState {
  displayMode: DisplayMode;
  clipPlane: ClipPlaneState;
  hiddenEntityIds: ReadonlySet<EntityId>;
  /** Local render override: never dispatches update_layer.visible. */
  hiddenLayerIds: ReadonlySet<string>;
  /** 'auto' derives the tier from document.order.length. */
  qualityOverride: QualityOverride;
  /** 3D object snapping during gizmo translate drags. */
  snap3dEnabled: boolean;
  /** Play/pause of `trigger:'auto'` animations. */
  animationPlaying: boolean;
  /** `trigger:'click'` animations toggled ON (a click on a target flips them). */
  activeClickAnimationIds: ReadonlySet<string>;
  /** Bumped by resetAnimations(): AnimationPlayer zeroes its phases on the next frame. */
  animationResetNonce: number;
  /** Highlighted MechanismsPanel item, drawn by the 3D overlay. */
  mechanismSelection: MechanismSelection | null;
  setDisplayMode(mode: DisplayMode): void;
  setClipPlane(patch: Partial<ClipPlaneState>): void;
  toggleClipPlane(): void;
  toggleEntityVisibility(id: EntityId): void;
  hideEntities(ids: readonly EntityId[]): void;
  /** Hides every id of `allIds` that is not in `keepIds`. */
  isolateEntities(keepIds: readonly EntityId[], allIds: readonly EntityId[]): void;
  showAllEntities(): void;
  toggleLayerVisibility(layerId: string): void;
  toggleSnap3d(): void;
  setQualityOverride(quality: QualityOverride): void;
  toggleAnimationPlaying(): void;
  setAnimationPlaying(playing: boolean): void;
  /** Stop playback, clear click animations, bump the reset nonce. */
  resetAnimations(): void;
  toggleClickAnimation(animId: string): void;
  setMechanismSelection(selection: MechanismSelection | null): void;
}

export const useViewportStore = create<ViewportStoreState>()((set) => ({
  displayMode: 'shaded',
  clipPlane: { enabled: false, axis: 'z', offset: 0, flipped: false },
  hiddenEntityIds: new Set<EntityId>(),
  hiddenLayerIds: new Set<string>(),
  snap3dEnabled: true,
  qualityOverride: 'auto',
  animationPlaying: false,
  activeClickAnimationIds: new Set<string>(),
  animationResetNonce: 0,
  mechanismSelection: null,
  setDisplayMode: (displayMode) => set({ displayMode }),
  setClipPlane: (patch) => set((state) => ({ clipPlane: { ...state.clipPlane, ...patch } })),
  toggleClipPlane: () => set((state) => ({ clipPlane: { ...state.clipPlane, enabled: !state.clipPlane.enabled } })),
  toggleEntityVisibility: (id) => set((state) => ({ hiddenEntityIds: toggledInSet(state.hiddenEntityIds, id) })),
  hideEntities: (ids) => set((state) => ({ hiddenEntityIds: new Set<EntityId>([...state.hiddenEntityIds, ...ids]) })),
  isolateEntities: (keepIds, allIds) => set({ hiddenEntityIds: new Set<EntityId>(allIds.filter((id) => !keepIds.includes(id))) }),
  showAllEntities: () => set({ hiddenEntityIds: new Set<EntityId>() }),
  toggleLayerVisibility: (layerId) => set((state) => ({ hiddenLayerIds: toggledInSet(state.hiddenLayerIds, layerId) })),
  toggleSnap3d: () => set((state) => ({ snap3dEnabled: !state.snap3dEnabled })),
  setQualityOverride: (qualityOverride) => set({ qualityOverride }),
  toggleAnimationPlaying: () => set((state) => ({ animationPlaying: !state.animationPlaying })),
  setAnimationPlaying: (animationPlaying) => set({ animationPlaying }),
  resetAnimations: () =>
    set((state) => ({
      animationPlaying: false,
      activeClickAnimationIds: new Set<string>(),
      animationResetNonce: state.animationResetNonce + 1,
    })),
  toggleClickAnimation: (animId) => set((state) => ({ activeClickAnimationIds: toggledInSet(state.activeClickAnimationIds, animId) })),
  setMechanismSelection: (mechanismSelection) => set({ mechanismSelection }),
}));
