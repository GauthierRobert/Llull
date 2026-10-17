/**
 * Splitting of large faces before the painter's sort: a centroid depth only orders faces correctly when they are small next to the gaps
 * between them, so a roof slab, a long beam or a wall is cut into pieces no longer than a fraction of the scene before it is sorted.
 */

import type { Vec3 } from '../../model/types';
import type { PreDepthPolygon } from './types';

type Tri = readonly [Vec3, Vec3, Vec3];

const midpoint = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Halves `tri` across its longest edge until no edge exceeds `maxEdge` (or the piece budget runs out). */
function bisect(tri: Tri, maxEdge: number, out: Tri[], budget: { left: number }): void {
  const [a, b, c] = tri;
  const edges: [number, Tri, Tri][] = [
    [distance(a, b), [a, midpoint(a, b), c], [midpoint(a, b), b, c]],
    [distance(b, c), [a, b, midpoint(b, c)], [a, midpoint(b, c), c]],
    [distance(c, a), [a, b, midpoint(c, a)], [midpoint(c, a), b, c]],
  ];
  const longest = edges.reduce((best, edge) => (edge[0] > best[0] ? edge : best));
  if (longest[0] <= maxEdge || budget.left <= 0) {
    out.push(tri);
    return;
  }
  budget.left -= 1;
  bisect(longest[1], maxEdge, out, budget);
  bisect(longest[2], maxEdge, out, budget);
}

/** True when every turn of the (planar) face has the same sense, so a fan from its first vertex stays inside it. */
function isConvex(verts: readonly Vec3[]): boolean {
  if (verts.length <= 3) return true;
  let reference: Vec3 | null = null;
  for (let i = 0; i < verts.length; i += 1) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const c = verts[(i + 2) % verts.length];
    if (a === undefined || b === undefined || c === undefined) return false;
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: Vec3 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const turn: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (Math.hypot(...turn) < 1e-12) continue;
    if (reference === null) reference = turn;
    else if (reference[0] * turn[0] + reference[1] * turn[1] + reference[2] * turn[2] < 0) return false;
  }
  return true;
}

const longestEdge = (verts: readonly Vec3[]): number =>
  verts.reduce((longest, vertex, index) => Math.max(longest, distance(vertex, verts[(index + 1) % verts.length] ?? vertex)), 0);

type Box = readonly [minU: number, minV: number, maxU: number, maxV: number];

function screenBox(verts: readonly Vec3[], toScreen: (p: Vec3) => readonly [number, number]): Box {
  let [minU, minV, maxU, maxV] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const vertex of verts) {
    const [u, v] = toScreen(vertex);
    [minU, minV, maxU, maxV] = [Math.min(minU, u), Math.min(minV, v), Math.max(maxU, u), Math.max(maxV, v)];
  }
  return [minU, minV, maxU, maxV];
}

const overlaps = (a: Box, b: Box): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** At most this many pieces per face. */
const MAX_PIECES_PER_FACE = 128;

/**
 * Filled faces with an edge longer than `maxEdge` whose screen box overlaps ANOTHER entity's (`owner`) screen box are fan-triangulated and
 * bisected into `seamless` pieces (drawn without outline so the cuts do not show); strokes, section caps, small faces and faces nothing
 * else can overlap pass through, as do concave faces (a fan would paint outside them). At most `maxExtra` pieces are added in total.
 * @pure
 */
export function splitForDepth(
  polygons: readonly PreDepthPolygon[],
  maxEdge: number,
  maxExtra: number,
  toScreen: (p: Vec3) => readonly [number, number],
): PreDepthPolygon[] {
  if (!(maxEdge > 0)) return [...polygons];
  const owners = new Map<string, Box>();
  for (const polygon of polygons) {
    if (polygon.owner === undefined || polygon.stroke) continue;
    const box = screenBox(polygon.verts, toScreen);
    const known = owners.get(polygon.owner);
    owners.set(
      polygon.owner,
      known === undefined
        ? box
        : [Math.min(known[0], box[0]), Math.min(known[1], box[1]), Math.max(known[2], box[2]), Math.max(known[3], box[3])],
    );
  }
  if (owners.size < 2) return [...polygons];
  const others = [...owners.entries()];
  const budget = { left: maxExtra };
  const out: PreDepthPolygon[] = [];
  for (const polygon of polygons) {
    const [first, ...rest] = polygon.verts;
    const large =
      !polygon.stroke &&
      polygon.loops === undefined &&
      first !== undefined &&
      longestEdge(polygon.verts) > maxEdge &&
      isConvex(polygon.verts);
    const box = large ? screenBox(polygon.verts, toScreen) : null;
    if (
      first === undefined ||
      box === null ||
      budget.left <= 0 ||
      !others.some(([owner, other]) => owner !== polygon.owner && overlaps(box, other))
    ) {
      out.push(polygon);
      continue;
    }
    const local = { left: Math.min(budget.left, MAX_PIECES_PER_FACE) };
    const before = local.left;
    const pieces: Tri[] = [];
    for (let index = 0; index + 1 < rest.length; index += 1) {
      const b = rest[index];
      const c = rest[index + 1];
      if (b !== undefined && c !== undefined) bisect([first, b, c], maxEdge, pieces, local);
    }
    budget.left -= before - local.left;
    for (const piece of pieces) out.push({ ...polygon, verts: [...piece], seamless: true });
  }
  return out;
}
