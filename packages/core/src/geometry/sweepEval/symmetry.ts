/** Rotational symmetry of a sweep section: the twist that maps it onto itself (closed paths need a whole number of those). */

import type { SweepEntity, Vec2 } from '../../model/types';
import type { SweepEvaluation, SweepShape } from './evaluate';
import { sectionTransforms } from './laws';
import { sectionLoops } from './sections';

/** Highest rotational symmetry order tested. */
const MAX_ORDER = 24;

/** Turns of the section's symmetry step (2π / order) that a total twist amounts to: a whole number when a closed path may carry it; 0 for a round section. */
export function symmetryTurns(section: SweepEntity['section'], totalTwist: number): number {
  const order = sectionSymmetryOrder(section);
  return Number.isFinite(order) ? totalTwist / ((2 * Math.PI) / order) : 0;
}

/**
 * Vertex of the first ring that vertex `j` of the last ring of a closed sweep coincides with is `(j + shift) mod pointCount`: a section carried through
 * `totalTwist` (a whole number of symmetry turns) lands on itself, each turn moving every counter-clockwise vertex on by `pointCount / order` (the order
 * divides the count: it is a cyclic index shift of the loop). A round section (any twist) shifts by the nearest vertex.
 */
function closingShift(section: SweepEntity['section'], totalTwist: number, pointCount: number): number {
  const order = sectionSymmetryOrder(section);
  const moved = Number.isFinite(order)
    ? Math.round(totalTwist / ((2 * Math.PI) / order)) * (pointCount / order)
    : Math.round((totalTwist * pointCount) / (2 * Math.PI));
  return ((moved % pointCount) + pointCount) % pointCount;
}

/** `closingShift` of a closed sweep for a ring of `pointCount` points: 0 without a twist law (or with rails, whose placement carries no twist law). */
export function sweepClosingShift(sweep: SweepShape, evaluation: SweepEvaluation, pointCount: number): number {
  if (evaluation.transforms === null || sweep.rails !== undefined) return 0;
  const [start, end] = sectionTransforms(sweep, [0, 1], evaluation.length);
  const total = (end?.twist ?? 0) - (start?.twist ?? 0);
  return Math.abs(total) < 1e-12 ? 0 : closingShift(sweep.section, total, pointCount);
}

/** True when rotating the loop by 2π / k maps vertex j onto vertex j + N / k for every j (k divides N). */
function rotatesOntoShift(loop: readonly Vec2[], k: number, tolerance: number): boolean {
  const angle = (2 * Math.PI) / k;
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const step = loop.length / k;
  return loop.every(([x, y], j) => {
    const [u, v] = loop[(j + step) % loop.length] as Vec2;
    return Math.hypot(x * c - y * s - u, x * s + y * c - v) <= tolerance;
  });
}

const orders = new WeakMap<object, number>();

/**
 * Order k of the rotation by 2π/k that maps the counter-clockwise outline onto itself vertex by vertex (vertex j onto j + N/k), as large as possible
 * (1 = none); Infinity for a round section. A vertex set that is symmetric but whose outline is not (a bow-tie ordering) has order 1.
 */
export function sectionSymmetryOrder(section: SweepEntity['section']): number {
  if (section.shape === 'circle') return Number.POSITIVE_INFINITY;
  const known = orders.get(section);
  if (known !== undefined) return known;
  const loop = sectionLoops(section).outer;
  const tolerance = Math.max(...loop.map(([x, y]) => Math.hypot(x, y)), 1e-12) * 1e-9;
  let order = 1;
  for (let k = Math.min(MAX_ORDER, loop.length); k > 1; k--)
    if (loop.length % k === 0 && rotatesOntoShift(loop, k, tolerance)) {
      order = k;
      break;
    }
  orders.set(section, order);
  return order;
}
