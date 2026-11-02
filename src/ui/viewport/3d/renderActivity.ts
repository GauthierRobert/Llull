// Pure render-scheduling decisions for the demand frameloop: when the shadow map / baked contact shadows are stale, and
// when to trade resolution for responsiveness. The in-Canvas RenderRig only feeds these functions and applies the result.

/** The shadow map depends on the casters, never on the camera: a pure orbit frame needs no shadow pass. */
export function shouldRefreshShadows(inputs: { dirty: boolean; sceneMoved: boolean }): boolean {
  return inputs.dirty || inputs.sceneMoved;
}

/** Baked contact shadows follow moving parts at most this often (Hz). */
const CONTACT_BAKE_MAX_HZ = 15;

export interface ContactBakeState {
  /** Timestamp (ms) of the last bake. */
  lastBakeMs: number;
  /** Something moved since the last bake that was skipped by the throttle (or is not yet baked). */
  pending: boolean;
}

export const INITIAL_CONTACT_BAKE: ContactBakeState = { lastBakeMs: Number.NEGATIVE_INFINITY, pending: false };

/**
 * Throttled re-bake: while the scene moves, bake at most `CONTACT_BAKE_MAX_HZ`; once it is still, bake once more if a
 * movement was skipped, so the frozen shadow always ends on the final pose.
 */
export function stepContactBake(
  state: ContactBakeState,
  sceneMoved: boolean,
  nowMs: number,
  maxHz: number = CONTACT_BAKE_MAX_HZ,
): { state: ContactBakeState; bake: boolean } {
  if (sceneMoved) {
    const due = nowMs - state.lastBakeMs >= 1000 / maxHz;
    return due ? { state: { lastBakeMs: nowMs, pending: false }, bake: true } : { state: { ...state, pending: true }, bake: false };
  }
  return state.pending ? { state: { lastBakeMs: nowMs, pending: false }, bake: true } : { state, bake: false };
}

/** True while a skipped movement still owes a bake, so the rig must schedule another frame. */
export function contactBakeOwed(state: ContactBakeState): boolean {
  return state.pending;
}

/** Fraction of the settled pixel ratio used while the view is moving. */
const INTERACTIVE_DPR_FACTOR = 0.6;
/** No motion for this long (ms) restores the full pixel ratio. */
export const DPR_SETTLE_MS = 180;

/** Pixel ratio of a still frame: the device ratio clamped to the Canvas `dpr={[min,max]}` range. */
export function settledDpr(deviceDpr: number, range: readonly [number, number]): number {
  return Math.min(Math.max(deviceDpr, range[0]), range[1]);
}

/** Pixel ratio while orbiting / animating: reduced, never below 1 and never above the settled ratio. */
export function interactiveDpr(settled: number): number {
  return Math.min(settled, Math.max(1, settled * INTERACTIVE_DPR_FACTOR));
}

export interface AdaptiveDprState {
  /** True while the reduced ratio is applied. */
  reduced: boolean;
  lastActiveMs: number;
}

export const INITIAL_ADAPTIVE_DPR: AdaptiveDprState = { reduced: false, lastActiveMs: Number.NEGATIVE_INFINITY };

/** Drops to the reduced ratio on activity, restores it after `DPR_SETTLE_MS` of calm. `changed` tells the rig to call setDpr. */
export function stepAdaptiveDpr(
  state: AdaptiveDprState,
  active: boolean,
  nowMs: number,
  canReduce: boolean,
): { state: AdaptiveDprState; changed: boolean } {
  if (active && canReduce) {
    return { state: { reduced: true, lastActiveMs: nowMs }, changed: !state.reduced };
  }
  if (state.reduced && !active && nowMs - state.lastActiveMs >= DPR_SETTLE_MS) {
    return { state: { reduced: false, lastActiveMs: state.lastActiveMs }, changed: true };
  }
  return { state: active ? { ...state, lastActiveMs: nowMs } : state, changed: false };
}

/** True when the camera pose (position xyz + quaternion xyzw) differs from the previous frame's. */
export function cameraPoseChanged(previous: Float64Array, next: ArrayLike<number>): boolean {
  let changed = false;
  for (let i = 0; i < previous.length; i += 1) {
    const value = next[i] ?? 0;
    if (previous[i] !== value) {
      changed = true;
      previous[i] = value;
    }
  }
  return changed;
}
