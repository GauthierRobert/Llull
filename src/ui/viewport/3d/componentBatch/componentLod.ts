// Screen-space LOD of one component batch (pure, no three.js): each instance is drawn at tier 0 (the real mesh), tier 1 (a decimated
// mesh, when the child has one) or tier 2 (its bounding box), chosen from the projected size of its world box. Deterministic: the same
// camera and boxes give the same tiers. Thresholds are the plant renderer's (LOD_THRESHOLDS_PX 48 / 8); `held` is the previous
// assignment and gives a 15 % hysteresis band so an instance on a threshold does not flicker.

import type { PackedBoxes } from '@core/geometry/instanceBvh';
import type { PlanCamera } from '@core/geometry/renderPlanCamera';
import { projectedPixels } from '@core/geometry/renderPlan';

export type ComponentLodTier = 0 | 1 | 2;

/** A component with fewer instances keeps one tier (the extra draw calls would cost more than the vertices saved). */
export const COMPONENT_LOD_MIN_INSTANCES = 24;
/** Under this projected diagonal (px) an instance leaves tier 0 for the coarse mesh. */
const COARSE_BELOW_PX = 48;
/** Under this projected diagonal (px) an instance is drawn as its bounding box. */
const BOX_BELOW_PX = 8;
const HOLD = 1.15;

function rawTier(pixels: number, hasCoarse: boolean, scale: number): ComponentLodTier {
  if (pixels < BOX_BELOW_PX * scale) return 2;
  return hasCoarse && pixels < COARSE_BELOW_PX * scale ? 1 : 0;
}

/** Tier of one instance of projected size `pixels`; `held` is its tier the last time (a coarser tier holds until the size passes 1.15x its threshold). */
export function tierForPixels(pixels: number, held: ComponentLodTier | undefined, hasCoarse: boolean): ComponentLodTier {
  const fresh = rawTier(pixels, hasCoarse, 1);
  if (held === undefined || held <= fresh) return fresh;
  return Math.min(held, rawTier(pixels, hasCoarse, HOLD)) as ComponentLodTier;
}

/**
 * Tier per box of `boxes` (packed world AABBs) for `camera`; `held` = the previous result of the same length.
 * @invariant the result has one entry per box; with no coarse mesh tier 1 never appears
 */
export function assignTiers(boxes: PackedBoxes, camera: PlanCamera, held: Uint8Array | undefined, hasCoarse: boolean): Uint8Array {
  const count = boxes.length / 6;
  const tiers = new Uint8Array(count);
  const eye = camera.eye;
  const sameLength = held !== undefined && held.length === count;
  for (let index = 0; index < count; index++) {
    const o = index * 6;
    const x0 = boxes[o] ?? 0;
    const y0 = boxes[o + 1] ?? 0;
    const z0 = boxes[o + 2] ?? 0;
    const x1 = boxes[o + 3] ?? 0;
    const y1 = boxes[o + 4] ?? 0;
    const z1 = boxes[o + 5] ?? 0;
    const distance = Math.hypot((x0 + x1) / 2 - eye[0], (y0 + y1) / 2 - eye[1], (z0 + z1) / 2 - eye[2]);
    const pixels = projectedPixels(Math.hypot(x1 - x0, y1 - y0, z1 - z0), distance, camera);
    tiers[index] = tierForPixels(pixels, sameLength ? (held[index] as ComponentLodTier) : undefined, hasCoarse);
  }
  return tiers;
}

export interface TierPacking {
  /** Instance indices of each tier, ascending: `members[tier][slot]`. */
  readonly members: [number[], number[], number[]];
  /** Slot of each instance inside its tier's InstancedMesh. */
  readonly slot: Int32Array;
}

/** Groups instance indices by tier. @invariant every index is in exactly one tier, ascending, and `members[tier][slot[i]] === i` */
export function packTiers(tiers: Uint8Array): TierPacking {
  const members: TierPacking['members'] = [[], [], []];
  const slot = new Int32Array(tiers.length);
  tiers.forEach((tier, index) => {
    const list = members[tier] ?? members[0];
    slot[index] = list.length;
    list.push(index);
  });
  return { members, slot };
}
