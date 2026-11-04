/**
 * Broad phase of `check_clashes` for large models (plant 09 VIS-M7): a static BVH over the world extents of the building solids answers
 * "which solids can touch this box" in ascending solid order, so the narrow phase visits the same pairs in the same order as the full scan.
 * @invariant `nearBox(box)` is a superset of the solids whose oriented box has a positive-depth overlap with `box`;
 *   extents are inflated by `EXTENT_MARGIN`, far above the rounding of the extent arithmetic
 */

import type { Vec3 } from '@core/model/types';
import { buildInstanceBvh, packBoxes } from '@core/geometry/instanceBvh';
import { type OrientedBox, boxExtent } from './clashBoxes';

const EXTENT_MARGIN = 1e-6;

/** Solids from which the BVH replaces the all-pairs scan (measured at VIS-M7, 09 spec §12.13). */
export const CLASH_BVH_THRESHOLD = 64;

export interface SolidIndex {
  /** Ascending indices of the solids whose extent touches the extent of `box`. */
  nearBox(box: OrientedBox): number[];
}

const inflate = (value: Vec3, sign: 1 | -1): Vec3 => [
  value[0] + sign * EXTENT_MARGIN,
  value[1] + sign * EXTENT_MARGIN,
  value[2] + sign * EXTENT_MARGIN,
];

/**
 * @invariant null (caller scans every solid) when any extent is not finite; otherwise `nearBox` never misses a touching solid
 */
export function solidIndex(boxes: readonly OrientedBox[]): SolidIndex | null {
  const extents = boxes.map((box) => boxExtent(box));
  if (!extents.every(({ min, max }) => min.every(Number.isFinite) && max.every(Number.isFinite))) return null;
  const bvh = buildInstanceBvh(packBoxes(extents.map(({ min, max }) => ({ min: inflate(min, -1), max: inflate(max, 1) }))));
  return {
    nearBox: (box) => {
      const { min, max } = boxExtent(box);
      return min.every(Number.isFinite) && max.every(Number.isFinite) ? bvh.boxQuery(min, max) : Array.from(boxes.keys());
    },
  };
}
