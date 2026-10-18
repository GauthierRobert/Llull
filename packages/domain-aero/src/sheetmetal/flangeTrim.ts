/** Re-fits the bends of a flat after one of its outline edges is moved inward (position material_inside on a flat that already has flanges). */

import type { Vec2 } from '@core/model/types';
import type { SheetMetalPart, SheetNode } from '@core/model/sheetMetal';
import { add3, normalize3, scale3 } from '@lib/vec3';
import { clipHalfPlane, EPS } from './geometry2d';
import { childBends, flatOf, type BendNode, type FlatNode } from './graph';

const distanceToLine = (point: Vec2, a: Vec2, b: Vec2): number => {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return Math.abs((point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0])) / length;
};

/**
 * Bends of `flat` that lie on the outline edge `index` of `before` are those the moved edge would orphan; bends on the two neighbouring edges
 * are clipped to the edge extents of `after`, and the child flat of each follows (frame origin, width, cutouts).
 * @returns replacement nodes, or a reason string when a bend cannot follow (it lies on the moved edge, or its flange carries further bends)
 */
export function refitBends(
  part: SheetMetalPart,
  flat: FlatNode,
  index: number,
  after: readonly Vec2[],
): { readonly nodes: SheetNode[] } | { readonly reason: string; readonly occupied: boolean } {
  const count = flat.outline.length;
  const nodes: SheetNode[] = [];
  for (const bend of childBends(part, flat.id)) {
    const [u, v] = bend.lineInFrom;
    const edge = flat.outline.findIndex(
      (a, i) =>
        distanceToLine(u, a, flat.outline[(i + 1) % count] as Vec2) < 1e-6 &&
        distanceToLine(v, a, flat.outline[(i + 1) % count] as Vec2) < 1e-6,
    );
    if (edge === index) return { reason: `bend ${bend.id} already lies on the picked edge`, occupied: true };
    if (edge !== (index + 1) % count && edge !== (index + count - 1) % count) continue;
    const refit = refitBend(part, bend, after[edge] as Vec2, after[(edge + 1) % count] as Vec2);
    if (typeof refit === 'string') return { reason: refit, occupied: false };
    nodes.push(...refit);
  }
  return { nodes };
}

function refitBend(part: SheetMetalPart, bend: BendNode, a: Vec2, b: Vec2): SheetNode[] | string {
  const [u, v] = bend.lineInFrom;
  const length = Math.hypot(v[0] - u[0], v[1] - u[1]);
  const direction: Vec2 = [(v[0] - u[0]) / length, (v[1] - u[1]) / length];
  const along = (point: Vec2): number => (point[0] - u[0]) * direction[0] + (point[1] - u[1]) * direction[1];
  const low = Math.max(0, Math.min(along(a), along(b)));
  const high = Math.min(length, Math.max(along(a), along(b)));
  if (low <= EPS && length - high <= EPS) return [];
  if (high - low <= EPS) return `bend ${bend.id} would vanish`;
  const child = flatOf(part, bend.to);
  if (child === undefined || childBends(part, child.id).length > 0)
    return `its neighbouring flange ${bend.to} carries further bends, so it cannot be shortened`;
  const width = high - low;
  const shifted = (point: Vec2): Vec2 => [point[0] - low, point[1]];
  const cut = clipHalfPlane(clipHalfPlane(child.outline.map(shifted), [0, 0], [1, 0], 'positive'), [width, 0], [-1, 0], 'positive');
  return [
    {
      ...bend,
      lineInFrom: [
        [u[0] + direction[0] * low, u[1] + direction[1] * low],
        [u[0] + direction[0] * high, u[1] + direction[1] * high],
      ],
    },
    {
      ...child,
      outline: cut,
      frame: { ...child.frame, origin: add3(child.frame.origin, scale3(normalize3(child.frame.xDir), low)) },
      cutouts: child.cutouts.map((cutout) => ({
        ...cutout,
        points: cutout.points.map(shifted),
        ...(cutout.circle ? { circle: { ...cutout.circle, center: shifted(cutout.circle.center) } } : {}),
      })),
    },
  ];
}
