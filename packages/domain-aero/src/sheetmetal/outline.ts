/** Merges edge-adjacent polygons (flats and bend zones of a flat pattern) into their outer boundary by cancelling shared edges. */

import type { Vec2 } from '@core/model/types';
import { projectOntoSegment, signedArea } from '@lib/polygon';

export interface MergedOutline {
  readonly outer: Vec2[];
  /** Interior loops left by the union (a ring of flats around a gap); usually empty. */
  readonly holes: Vec2[][];
}

type Edge = readonly [number, number];

function removeCollinear(loop: readonly Vec2[], tol: number): Vec2[] {
  const n = loop.length;
  return loop.filter((point, i) => {
    const previous = loop[(i + n - 1) % n] as Vec2;
    const next = loop[(i + 1) % n] as Vec2;
    const cross = (point[0] - previous[0]) * (next[1] - point[1]) - (point[1] - previous[1]) * (next[0] - point[0]);
    const dot = (point[0] - previous[0]) * (next[0] - point[0]) + (point[1] - previous[1]) * (next[1] - point[1]);
    const scale = Math.hypot(point[0] - previous[0], point[1] - previous[1]) * Math.hypot(next[0] - point[0], next[1] - point[1]);
    return !(Math.abs(cross) <= tol * Math.max(scale, 1) && dot > 0);
  });
}

/**
 * Union boundary of CCW polygons that touch along whole or partial edges.
 * @failure no polygons, or no closed boundary left -> null
 */
export function mergePolygons(polygons: ReadonlyArray<readonly Vec2[]>): MergedOutline | null {
  const all = polygons.flat();
  if (all.length === 0) return null;
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const tol = 1e-7 * Math.max(1, diagonal);
  const vertices: Vec2[] = [];
  const canon = (p: Vec2): number => {
    const known = vertices.findIndex((v) => Math.hypot(v[0] - p[0], v[1] - p[1]) <= tol);
    if (known >= 0) return known;
    vertices.push(p);
    return vertices.length - 1;
  };
  const rings = polygons.map((polygon) => polygon.map(canon));
  const directed: Edge[] = [];
  for (const ring of rings)
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length] as number;
      if (a === b) return;
      const from = vertices[a] as Vec2;
      const to = vertices[b] as Vec2;
      const between = vertices
        .map((point, index) => ({ index, ...projectOntoSegment(point, from, to) }))
        .filter((hit) => hit.index !== a && hit.index !== b && hit.distance <= tol && hit.t > 0 && hit.t < 1)
        .sort((x, y) => x.t - y.t)
        .map((hit) => hit.index);
      const chain = [a, ...between, b];
      for (let k = 0; k + 1 < chain.length; k++) directed.push([chain[k] as number, chain[k + 1] as number]);
    });
  const live = new Map<string, Edge>(directed.map((edge) => [`${edge[0]}>${edge[1]}`, edge]));
  for (const [key, edge] of [...live]) {
    const reverse = `${edge[1]}>${edge[0]}`;
    if (live.has(key) && live.has(reverse)) {
      live.delete(key);
      live.delete(reverse);
    }
  }
  const outgoing = new Map<number, number[]>();
  for (const [a, b] of live.values()) outgoing.set(a, [...(outgoing.get(a) ?? []), b]);
  const loops: Vec2[][] = [];
  while (outgoing.size > 0) {
    const start = outgoing.keys().next().value as number;
    const loop: number[] = [start];
    let current = start;
    for (let guard = 0; guard <= live.size; guard++) {
      const options = outgoing.get(current);
      const next = options?.shift();
      if (options?.length === 0) outgoing.delete(current);
      if (next === undefined) break;
      if (next === start) break;
      loop.push(next);
      current = next;
    }
    if (loop.length >= 3)
      loops.push(
        removeCollinear(
          loop.map((index) => vertices[index] as Vec2),
          tol,
        ),
      );
  }
  const outer = loops.filter((loop) => signedArea(loop) > 0).sort((a, b) => signedArea(b) - signedArea(a))[0];
  if (outer === undefined) return null;
  return { outer, holes: loops.filter((loop) => loop !== outer && signedArea(loop) < 0) };
}
