/**
 * Which native shapes were built from the groove tool of a modelled thread (07 FTR FR-FTR-20). Such a shape carries thousands of planar facets:
 * post-boolean UnifySameDomain never returns on it and its display mesh needs a finer deflection. The mark follows every operation derived from it.
 * @invariant a result is marked iff an operand is; a shape never built from a thread tool is never marked
 */

import type { OccShape } from './occtTypes';

const marked = new WeakSet<OccShape>();

/** `shape`, now marked as thread-bearing. */
export function markThreadBearing(shape: OccShape): OccShape {
  marked.add(shape);
  return shape;
}

/** Whether any of `shapes` is thread-bearing. */
export const isThreadBearing = (...shapes: readonly OccShape[]): boolean => shapes.some((shape) => marked.has(shape));

/** `result` (marked when any operand is); null stays null. */
export function inheritThreadMark(result: OccShape | null, ...operands: readonly OccShape[]): OccShape | null {
  return result !== null && isThreadBearing(...operands) ? markThreadBearing(result) : result;
}
