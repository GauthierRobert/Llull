// Which members of an instance array a camera draws, and at which tier (pure, no three.js, no React). Members live in a packed float64
// table (no object per member), so every pass here is a typed-array loop: a 4,000,000-member array is one pass of a few tens of ms,
// run when the camera settles or moves (PlantCameraProvider throttles that), never per frame. Thresholds are the render plan's
// (`componentLod`): tier 0 = real mesh, 1 = decimated mesh, 2 = bounding box, culled = outside the frustum or under one pixel.

import { projectedPixels } from '@core/geometry/renderPlan';
import { type PlanCamera, frustumPlanes } from '@core/geometry/renderPlanCamera';
import { INSTANCE_STRIDE, type InstanceArray } from '@core/model/instanceArray';
import type { CadDocument, Vec3 } from '@core/model/types';
import { type ComponentLodTier, tierForPixels } from '../componentBatch/componentLod';

/** Tier value of a member the camera does not draw. */
const TIER_CULLED = 3;
/** Most members drawn per array at once (a mesh holds 64 B per member); the excess, farthest tier last, is dropped (`TierMembers.dropped`; the renderer warns once per count). */
const MAX_DRAWN_MEMBERS = 1_500_000;

/** Bounding sphere about a member's origin and the box diagonal, both for one member after the array's scale. */
export interface MemberShape {
  readonly radius: number;
  readonly diagonal: number;
}

/** Shape of a component whose local corners are `corners`; null for an empty component. */
export function memberShape(corners: readonly Vec3[], scale: Vec3 = [1, 1, 1]): MemberShape | null {
  if (corners.length === 0) return null;
  let radius = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const corner of corners) {
    const scaled = [corner[0] * scale[0], corner[1] * scale[1], corner[2] * scale[2]] as const;
    radius = Math.max(radius, Math.hypot(scaled[0], scaled[1], scaled[2]));
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis] ?? Infinity, scaled[axis] ?? 0);
      max[axis] = Math.max(max[axis] ?? -Infinity, scaled[axis] ?? 0);
    }
  }
  return { radius, diagonal: Math.hypot((max[0] ?? 0) - (min[0] ?? 0), (max[1] ?? 0) - (min[1] ?? 0), (max[2] ?? 0) - (min[2] ?? 0)) };
}

/** The arrays that are drawn: document layer visible and not hidden by the viewport filter. */
export function visibleInstanceArrays(
  arrays: CadDocument['instanceArrays'],
  layers: CadDocument['layers'],
  hiddenLayerIds: ReadonlySet<string>,
): InstanceArray[] {
  return Object.values(arrays ?? {}).filter((array) => layers[array.layerId]?.visible !== false && !hiddenLayerIds.has(array.layerId));
}

export interface TierOptions {
  /** Tier-1 geometry exists for the component. */
  readonly hasCoarse: boolean;
  /** The previous result for this table (hysteresis); ignored when its length differs. */
  readonly held?: Uint8Array | undefined;
}

/**
 * Tier per member of `table` (`count` members): `TIER_CULLED` when the bounding sphere is outside the frustum or the box diagonal projects
 * under one pixel, else 0 / 1 / 2 by projected size with hysteresis.
 * @invariant one entry per member; with `hasCoarse` false tier 1 never appears
 */
export function assignMemberTiers(
  table: Float64Array,
  count: number,
  shape: MemberShape,
  camera: PlanCamera,
  options: TierOptions,
): Uint8Array {
  const planes = frustumPlanes(camera);
  const plane = new Float64Array(planes.length * 4);
  planes.forEach(({ normal, offset }, index) => plane.set([normal[0], normal[1], normal[2], offset], index * 4));
  const tiers = new Uint8Array(count);
  const { held } = options;
  const sameLength = held !== undefined && held.length === count;
  const [ex, ey, ez] = camera.eye;
  const radius = shape.radius;
  const planeCount = planes.length;
  for (let index = 0; index < count; index++) {
    const at = index * INSTANCE_STRIDE;
    const x = table[at] ?? 0;
    const y = table[at + 1] ?? 0;
    const z = table[at + 2] ?? 0;
    let inside = true;
    for (let p = 0; p < planeCount * 4; p += 4) {
      if ((plane[p] ?? 0) * x + (plane[p + 1] ?? 0) * y + (plane[p + 2] ?? 0) * z + (plane[p + 3] ?? 0) < -radius) {
        inside = false;
        break;
      }
    }
    if (!inside) {
      tiers[index] = TIER_CULLED;
      continue;
    }
    const pixels = projectedPixels(shape.diagonal, Math.hypot(x - ex, y - ey, z - ez), camera);
    tiers[index] =
      pixels < 1 ? TIER_CULLED : tierForPixels(pixels, sameLength ? (held[index] as ComponentLodTier) : undefined, options.hasCoarse);
  }
  return tiers;
}

export interface TierMembers {
  /** Member indices per tier, ascending. */
  readonly members: readonly [Uint32Array, Uint32Array, Uint32Array];
  /** Visible members left out because more than `cap` are on screen. */
  readonly dropped: number;
}

/** Member indices of each drawn tier; past `cap` drawn members the later tiers (then later members) are dropped. */
export function groupTiers(tiers: Uint8Array, cap: number = MAX_DRAWN_MEMBERS): TierMembers {
  const counts = [0, 0, 0];
  for (const tier of tiers) if (tier < TIER_CULLED) counts[tier] = (counts[tier] ?? 0) + 1;
  let left = cap;
  const room = counts.map((n) => {
    const kept = Math.min(n, left);
    left -= kept;
    return kept;
  });
  const members = room.map((n) => new Uint32Array(n)) as unknown as [Uint32Array, Uint32Array, Uint32Array];
  const filled = [0, 0, 0];
  tiers.forEach((tier, index) => {
    const list = members[tier];
    const used = filled[tier] ?? 0;
    if (tier >= TIER_CULLED || list === undefined || used >= list.length) return;
    list[used] = index;
    filled[tier] = used + 1;
  });
  return { members, dropped: counts.reduce((sum, n, tier) => sum + n - (room[tier] ?? 0), 0) };
}
