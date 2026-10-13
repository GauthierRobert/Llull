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

/** Segment p→q offset by `distance` (positive = left of travel). */
export function offsetSegment(p: Vec2, q: Vec2, distance: number): [Vec2, Vec2] {
  const shift = scale2(normalize2(perp2(sub2(q, p))), distance);
  return [add2(p, shift), add2(q, shift)];
}

/** Miter point of consecutive offset segments [a0,a1], [b0,b1] (their lines' intersection); a1 (butt join) when parallel. */
export function miterJoin(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): Vec2 {
  return lineIntersection(a0, a1, b0, b1) ?? a1;
}
