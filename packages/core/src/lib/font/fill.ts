/**
 * Nonzero fill of a set of outline loops into regions (one outer loop + its holes). Loops that do not touch are classified by containment depth
 * (even = outer, odd = hole of the smallest enclosing loop), which equals the nonzero rule for a well-formed glyph and keeps every curve exact.
 * Overlapping contours (variable-font instances: OVERLAP_SIMPLE / OVERLAP_COMPOUND) are united on flattened polygons instead: the result is then
 * polygonal and `united` is true (TECHNICAL_SPEC §5.4).
 * @failure a hole that crosses an outer it does not belong to, or crossing loops of opposite winding -> `{ error }`
 */

import type { Vec2 } from '../../model/vectors';
import { pointInPolygon, segmentsIntersect } from '../polygon';
import { unionPolygons } from '../polygonBoolean';
import { flattenLoop, loopArea, loopBox, type OutlineBox, type OutlineLoop } from './outline';

export interface FillRegion {
  readonly outer: OutlineLoop;
  readonly holes: readonly OutlineLoop[];
}

export type FillResult =
  | { readonly regions: readonly FillRegion[]; readonly united: boolean }
  | { readonly error: 'self_intersect'; readonly loop: number };

const FLATTEN = 8;
const UNION_FLATTEN = 24;

interface Item {
  readonly loop: OutlineLoop;
  readonly polygon: readonly Vec2[];
  readonly box: OutlineBox;
  readonly area: number;
}

const boxesOverlap = (a: OutlineBox, b: OutlineBox): boolean =>
  a.min[0] <= b.max[0] && b.min[0] <= a.max[0] && a.min[1] <= b.max[1] && b.min[1] <= a.max[1];

function polygonsCross(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      if (segmentsIntersect(a[i] as Vec2, a[(i + 1) % a.length] as Vec2, b[j] as Vec2, b[(j + 1) % b.length] as Vec2)) return true;
  return false;
}

const lineLoop = (polygon: readonly Vec2[]): OutlineLoop =>
  polygon.map((from, k) => ({ kind: 'line' as const, from, to: polygon[(k + 1) % polygon.length] as Vec2 }));

/** Overlapping contours: filled loops (negative area, TrueType) are united, holes (positive area) kept when they lie in exactly one united ring. */
function uniteOverlaps(
  items: readonly Item[],
): { readonly loops: OutlineLoop[] } | { readonly error: 'self_intersect'; readonly loop: number } {
  const filled = items.filter((item) => item.area < 0).map((item) => flattenLoop(item.loop, UNION_FLATTEN).reverse());
  const holes = items.filter((item) => item.area > 0).map((item) => flattenLoop(item.loop, UNION_FLATTEN));
  const rings = unionPolygons(filled);
  const loops = rings.map(lineLoop);
  for (const [index, hole] of holes.entries()) {
    const owner = rings.findIndex((ring) => pointInPolygon(hole[0] as Vec2, ring));
    if (owner < 0 || rings.some((ring) => polygonsCross(ring, hole))) return { error: 'self_intersect', loop: index };
    loops.push(lineLoop(hole));
  }
  return { loops };
}

const itemOf = (loop: OutlineLoop): Item => ({
  loop,
  polygon: flattenLoop(loop, FLATTEN),
  box: loopBox(loop) as OutlineBox,
  area: loopArea(loop),
});

/** Clusters of loops that cross each other (union-find over crossing pairs whose boxes overlap); only clusters of two or more need uniting. */
function crossingClusters(items: readonly Item[]): number[][] {
  const root = items.map((_, index) => index);
  const find = (index: number): number => {
    let at = index;
    while (root[at] !== at) at = root[at] as number;
    return at;
  };
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const [a, b] = [items[i] as Item, items[j] as Item];
      if (boxesOverlap(a.box, b.box) && polygonsCross(a.polygon, b.polygon)) root[find(j)] = find(i);
    }
  const groups = new Map<number, number[]>();
  items.forEach((_, index) => groups.set(find(index), [...(groups.get(find(index)) ?? []), index]));
  return [...groups.values()].filter((group) => group.length > 1);
}

/** Group `loops` (any orientation) into regions; see the module comment. */
export function fillRegions(loops: readonly OutlineLoop[]): FillResult {
  let items: Item[] = loops.filter((loop) => loop.length > 0).map(itemOf);
  const clusters = crossingClusters(items);
  const united = clusters.length > 0;
  if (united) {
    const clustered = new Set(clusters.flat());
    const replaced: Item[] = items.filter((_, index) => !clustered.has(index));
    for (const cluster of clusters) {
      const result = uniteOverlaps(cluster.map((index) => items[index] as Item));
      if ('error' in result) return result;
      replaced.push(...result.loops.map(itemOf));
    }
    items = replaced;
  }
  const order = items.map((_, index) => index).sort((p, q) => Math.abs((items[q] as Item).area) - Math.abs((items[p] as Item).area));
  const depth = new Map<number, number>();
  const parent = new Map<number, number>();
  for (const [rank, index] of order.entries()) {
    const probe = (items[index] as Item).polygon[0] as Vec2;
    const containers = order.slice(0, rank).filter((other) => pointInPolygon(probe, (items[other] as Item).polygon));
    depth.set(index, containers.length);
    const closest = containers[containers.length - 1];
    if (closest !== undefined) parent.set(index, closest);
  }
  const regions = new Map<number, { outer: OutlineLoop; holes: OutlineLoop[] }>();
  for (const index of order) {
    const item = items[index] as Item;
    if ((depth.get(index) as number) % 2 === 0) regions.set(index, { outer: item.loop, holes: [] });
  }
  for (const index of order) {
    if ((depth.get(index) as number) % 2 === 0) continue;
    const owner = regions.get(parent.get(index) as number);
    if (owner === undefined) return { error: 'self_intersect', loop: index };
    owner.holes.push((items[index] as Item).loop);
  }
  return { regions: order.filter((index) => regions.has(index)).map((index) => regions.get(index) as FillRegion), united };
}
