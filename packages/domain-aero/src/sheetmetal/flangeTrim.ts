/** Re-fits the bends of a flat after one of its outline edges is moved inward (position material_inside on a flat that already has flanges). */

import type { Vec2 } from '@core/model/types';
import type { SheetMetalPart, SheetNode } from '@core/model/sheetMetal';
import { add3, normalize3, scale3 } from '@lib/vec3';
import { cornerNotch } from './cornerGeometry';
import { clipHalfPlane, EPS, moveEdgeInward } from './geometry2d';
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
    const [was, now] = [flat.outline, after].map((ring) => [ring[edge] as Vec2, ring[(edge + 1) % count] as Vec2]) as [Vec2[], Vec2[]];
    if (was.every((point, i) => Math.hypot(point[0] - (now[i] as Vec2)[0], point[1] - (now[i] as Vec2)[1]) < 1e-9)) continue;
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

type CornerReliefNode = Extract<SheetNode, { type: 'corner_relief' }>;

const near = (a: Vec2, b: Vec2): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

/**
 * Moves outline edge `index` inward by `shift` on a flat that carries corner reliefs: the notches are closed back to their sharp corners,
 * the edge is moved, and each notch is re-cut (same size) at its - possibly displaced - corner.
 * @returns the new outline with the updated corner_relief nodes, null when no relief sits on the flat, or a reason string when the move or a re-cut is impossible
 */
export function trimWithCornerReliefs(
  part: SheetMetalPart,
  flat: FlatNode,
  index: number,
  shift: number,
): { readonly outline: Vec2[]; readonly nodes: CornerReliefNode[] } | string | null {
  const reliefs = Object.values(part.nodes).filter(
    (node): node is CornerReliefNode => node.type === 'corner_relief' && node.on === flat.id,
  );
  if (reliefs.length === 0) return null;
  const ring = flat.outline;
  const count = ring.length;
  const notched = new Map<number, CornerReliefNode>();
  const skipped = new Set<number>();
  ring.forEach((b, i) => {
    const [a, c] = [ring[(i + count - 1) % count] as Vec2, ring[(i + 1) % count] as Vec2];
    const sharp: Vec2 = [a[0] + c[0] - b[0], a[1] + c[1] - b[1]];
    const relief = reliefs.find((node) => near(node.corner, sharp) && Math.abs(Math.hypot(a[0] - b[0], a[1] - b[1]) - node.size) < 1e-6);
    if (relief === undefined || notched.has(i) || skipped.has(i) || skipped.has((i + count - 1) % count) || skipped.has((i + 1) % count))
      return;
    notched.set(i, relief);
    skipped.add((i + count - 1) % count);
    skipped.add((i + 1) % count);
  });
  if (notched.size !== reliefs.length) return null;
  const sharpRing: Array<{ readonly point: Vec2; readonly relief?: CornerReliefNode }> = [];
  ring.forEach((point, i) => {
    const relief = notched.get(i);
    if (relief !== undefined) sharpRing.push({ point: relief.corner, relief });
    else if (!skipped.has(i)) sharpRing.push({ point });
  });
  const [from, to] = [ring[index] as Vec2, ring[(index + 1) % count] as Vec2];
  const moved = sharpRing.findIndex(({ point }, i) => {
    const next = sharpRing[(i + 1) % sharpRing.length]?.point as Vec2;
    return (
      distanceToLine(from, point, next) < 1e-6 &&
      distanceToLine(to, point, next) < 1e-6 &&
      (to[0] - from[0]) * (next[0] - point[0]) + (to[1] - from[1]) * (next[1] - point[1]) > 0
    );
  });
  if (moved < 0) return null;
  const trimmed = moveEdgeInward(
    sharpRing.map(({ point }) => point),
    moved,
    shift,
  );
  if (trimmed === null) return 'the flat is too small to trim, even with its corner reliefs closed';
  let outline = trimmed;
  const nodes: CornerReliefNode[] = [];
  for (let i = sharpRing.length - 1; i >= 0; i--) {
    const relief = sharpRing[i]?.relief;
    if (relief === undefined) continue;
    const cut = cornerNotch(outline, i, relief.size);
    if (cut === null)
      return `corner relief ${relief.id} (${relief.size} square) no longer fits at [${(trimmed[i] as Vec2).map((v) => v.toFixed(3)).join(', ')}] after the trim: an adjacent edge would become shorter than the notch`;
    outline = cut.outline;
    nodes.push({ ...relief, corner: trimmed[i] as Vec2 });
  }
  return { outline, nodes };
}
