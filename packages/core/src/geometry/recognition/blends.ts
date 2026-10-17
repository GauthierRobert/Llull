/**
 * Fillets, chamfers and sheet-metal bends (07 FTR §5.6 steps 4-5), after holes and pockets took their faces.
 * @invariant a fillet is a partial cylinder / torus tangent (smooth edges) to its neighbours; a bend is a coaxial inner (concave, R) and outer
 *   (convex, R + T) cylinder pair of equal angular span; a chamfer is a planar strip at 45 degrees to two perpendicular faces
 */

import { roundTo } from '../../lib/compactNumber';
import { dot3 } from '../../lib/vec3';
import { type Group, type Model, distanceToAxis, outwardNormal } from './model';
import type { RecognizedBend, RecognizedChamfer, RecognizedFillet } from './types';

const FULL_TURN = 2 * Math.PI - 1e-3;
/** Spans closer than this (radians) are the same bend angle. */
const SPAN_TOLERANCE = 1e-4;
const CHAMFER_ANGLE = Math.PI / 4;
const CHAMFER_ANGLE_TOLERANCE = (0.5 * Math.PI) / 180;
const r = (value: number): number => roundTo(value, 9) + 0;

const smoothCount = (model: Model, group: Group): number => model.boundary(group).filter((entry) => entry.convexity === 'smooth').length;

const partial = (group: Group): boolean => group.span > 0 && group.span < FULL_TURN;

/** Bend pairs among the free partial cylinders; `taken` receives both members. */
export function recognizeBends(model: Model, taken: Set<Group>): RecognizedBend[] {
  const cylinders = model.groups.filter((g) => !taken.has(g) && g.surface.type === 'cylinder' && partial(g) && smoothCount(model, g) >= 2);
  const bends: RecognizedBend[] = [];
  for (const inner of cylinders) {
    const innerSurface = inner.surface;
    if (!inner.reversed || innerSurface.type !== 'cylinder' || taken.has(inner)) continue;
    const outer = cylinders.find((candidate) => {
      const surface = candidate.surface;
      return (
        !taken.has(candidate) &&
        !candidate.reversed &&
        surface.type === 'cylinder' &&
        surface.radius > innerSurface.radius + model.tolerance.length &&
        Math.abs(candidate.span - inner.span) < SPAN_TOLERANCE &&
        1 - Math.abs(dot3(surface.axis, innerSurface.axis)) < model.tolerance.angle ** 2 &&
        distanceToAxis(surface.origin, innerSurface.origin, innerSurface.axis) < model.tolerance.length
      );
    });
    if (outer === undefined || outer.surface.type !== 'cylinder') continue;
    taken.add(inner);
    taken.add(outer);
    const origin = innerSurface.origin;
    bends.push({
      innerRadius: r(innerSurface.radius),
      thickness: r(outer.surface.radius - innerSurface.radius),
      angleDeg: r((inner.span * 180) / Math.PI),
      axisPoint: [r(origin[0]), r(origin[1]), r(origin[2])],
      axis: [r(innerSurface.axis[0]), r(innerSurface.axis[1]), r(innerSurface.axis[2])],
      faceIndices: [...inner.faces, ...outer.faces].sort((a, b) => a - b),
    });
  }
  return bends.sort((a, b) => a.axisPoint[0] - b.axisPoint[0] || a.axisPoint[1] - b.axisPoint[1] || a.axisPoint[2] - b.axisPoint[2]);
}

/** Fillets: free partial cylinders / tori tangent to their neighbours. */
export function recognizeFillets(model: Model, taken: Set<Group>): RecognizedFillet[] {
  const fillets: RecognizedFillet[] = [];
  for (const group of model.groups) {
    const surface = group.surface;
    if (taken.has(group) || !partial(group) || smoothCount(model, group) < 2) continue;
    const radius = surface.type === 'cylinder' ? surface.radius : surface.type === 'torus' ? surface.minor : 0;
    if (!(radius > 0)) continue;
    taken.add(group);
    fillets.push({ radius: r(radius), convex: !group.reversed, faceIndices: [...group.faces].sort((a, b) => a - b) });
  }
  return fillets.sort((a, b) => a.radius - b.radius || (a.faceIndices[0] ?? 0) - (b.faceIndices[0] ?? 0));
}

const angleBetween = (a: readonly number[], b: readonly number[]): number =>
  Math.acos(Math.max(-1, Math.min(1, (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0))));

/** Chamfers: free planar strips at 45 degrees to two perpendicular planar neighbours. */
export function recognizeChamfers(model: Model, taken: Set<Group>): RecognizedChamfer[] {
  const chamfers: RecognizedChamfer[] = [];
  for (const group of model.groups) {
    const normal = outwardNormal(group);
    if (taken.has(group) || normal === null) continue;
    const sides = model
      .boundary(group)
      .map((entry) => ({ entry, other: outwardNormal(entry.other) }))
      .filter(
        ({ entry, other }) =>
          other !== null && entry.convexity !== 'smooth' && Math.abs(angleBetween(normal, other) - CHAMFER_ANGLE) < CHAMFER_ANGLE_TOLERANCE,
      );
    const [first, second] = sides;
    if (sides.length !== 2 || first?.other == null || second?.other == null || Math.abs(dot3(first.other, second.other)) > 1e-3) continue;
    const lengths = sides.map(({ entry }) => model.topology.edges[entry.edge]?.length ?? 0);
    const area = group.faces.reduce((sum, face) => sum + (model.graph.faces[face]?.area ?? 0), 0);
    const along = Math.max(...lengths);
    if (!(along > 0)) continue;
    taken.add(group);
    chamfers.push({ distance: r(area / along / Math.SQRT2), faceIndices: [...group.faces].sort((a, b) => a - b) });
  }
  return chamfers.sort((a, b) => a.distance - b.distance || (a.faceIndices[0] ?? 0) - (b.faceIndices[0] ?? 0));
}
