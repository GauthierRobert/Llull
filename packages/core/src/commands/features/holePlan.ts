/** `add_hole` plan steps for recognised holes (07 FTR FR-FTR-25): holes with the same spec, extent and entrance plane become one step. */

import { round6 } from '../../lib/compactNumber';
import type { RecognizedHole } from '../../geometry/recognition/types';
import { dot3 } from '../../lib/vec3';

export interface HolePlanAction {
  readonly command: 'add_hole';
  readonly params: Readonly<Record<string, unknown>>;
  readonly as: string;
}

/** The `hole` and `extent` params of `add_hole` that rebuild `hole` (a cone atop a counterbore = counterdrill, whose depth is from the face). */
function holeParams(hole: RecognizedHole): { hole: Record<string, unknown>; extent: Record<string, unknown> } {
  const both = hole.cboreDiameter !== undefined && hole.cskDiameter !== undefined;
  const spec: Record<string, unknown> = { kind: both ? 'counterdrill' : hole.subtype, diameter: hole.diameter };
  if (hole.cboreDiameter !== undefined)
    Object.assign(spec, { cboreDiameter: hole.cboreDiameter, cboreDepth: (hole.cboreDepth ?? 0) + (both ? (hole.cskDepth ?? 0) : 0) });
  if (hole.cskDiameter !== undefined) Object.assign(spec, { cskDiameter: hole.cskDiameter, cskAngle: hole.cskAngleDeg });
  const extent: Record<string, unknown> = hole.through
    ? { kind: 'through_all' }
    : { kind: 'blind', depth: hole.depth, drillPointAngle: hole.drillPointAngleDeg ?? 0 };
  return { hole: spec, extent };
}

/**
 * Steps cutting `holes` into `stock` one group at a time; the first step targets `stock`, each next one the previous alias `h<k>`.
 * @invariant a group shares kind, diameters, extent, entrance plane and axis; its points are the world axis points ([x, y, z], pointsFrame "world")
 */
export function holePlan(holes: readonly RecognizedHole[], stock: string): HolePlanAction[] {
  const groups = new Map<string, { first: RecognizedHole; points: Array<readonly [number, number, number]> }>();
  for (const hole of holes) {
    const key = JSON.stringify([holeParams(hole), hole.axis.map(round6), round6(dot3(hole.axis, hole.axisPoint))]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { first: hole, points: [hole.axisPoint] });
    else group.points.push(hole.axisPoint);
  }
  return [...groups.values()].map(({ first, points }, index): HolePlanAction => {
    const target = index === 0 ? stock : `$h${index}`;
    return {
      command: 'add_hole',
      params: { target, face: { near: first.axisPoint }, points, pointsFrame: 'world', ...holeParams(first) },
      as: `h${index + 1}`,
    };
  });
}
