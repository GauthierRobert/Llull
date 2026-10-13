import type { CadDocument, PolylineEntity, Vec2 } from '../../model/types';
import type { CommandResult } from '../types';
import { lineIntersection } from '../../lib/polygon';
import { add2, normalize2, perp2, scale2, sub2 } from '../../lib/vec2';
import { noop } from '../noop';
import { entityOfKind } from '../entity/entityOfKind';

/** The polyline entity `id`, or the no-op result naming `command` when it is missing or another kind. */
export function resolvePolyline(doc: CadDocument, command: string, id: string): PolylineEntity | CommandResult {
  const found = entityOfKind(doc, id, ['polyline']);
  return typeof found === 'string' ? noop(doc, `${command}: ${found}.`) : found;
}

/**
 * Offset a single segment (p→q) by `distance` (positive = left of travel direction).
 * Returns the two endpoints of the offset segment.
 */
export function offsetSegment(p: Vec2, q: Vec2, distance: number): [Vec2, Vec2] {
  const shift = scale2(normalize2(perp2(sub2(q, p))), distance);
  return [add2(p, shift), add2(q, shift)];
}

/**
 * Miter-join two consecutive offset segments.
 * Given the endpoints of two consecutive offset segments [a0,a1] and [b0,b1],
 * returns the intersection of the infinite lines through them (the miter point).
 * Falls back to a[1] (simple butt join) if the lines are parallel.
 */
export function miterJoin(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): Vec2 {
  return lineIntersection(a0, a1, b0, b1) ?? a1; // parallel — butt join
}
