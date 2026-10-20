/** Conforming triangulation of a chart polygon with a bounded edge length (Rivara longest-edge bisection), for meshes on curved tool faces. */

import type { Vec2 } from '@core/model/types';
import { pointInPolygon, polygonArea, toCounterClockwise } from '@lib/polygon';
import { clipToConvex } from '@lib/polygonBoolean';
import { triangulatePolygon } from '@lib/triangulate';
import { densify } from './drape/flatten';

export interface ChartMesh {
  readonly uv: Vec2[];
  readonly triangles: [number, number, number][];
}

const MAX_TRIANGLES = 60_000;

const edgeKey = (p: number, q: number): string => (p < q ? `${p}:${q}` : `${q}:${p}`);

const MAX_CELLS = 40_000;

/** Structured mesh: the bounding grid of cell size maxEdge / sqrt 2, cells cut by the polygon clipped to it, interior cells kept whole. */
function gridMesh(outer: readonly Vec2[], maxEdge: number): ChartMesh | null {
  const ring = toCounterClockwise(outer);
  const [x0, x1] = [Math.min(...ring.map(([x]) => x)), Math.max(...ring.map(([x]) => x))];
  const [y0, y1] = [Math.min(...ring.map(([, y]) => y)), Math.max(...ring.map(([, y]) => y))];
  let h = maxEdge / Math.SQRT2;
  while (Math.ceil((x1 - x0) / h) * Math.ceil((y1 - y0) / h) > MAX_CELLS) h *= 1.25;
  const [nx, ny] = [Math.max(1, Math.ceil((x1 - x0) / h)), Math.max(1, Math.ceil((y1 - y0) / h))];
  const cell = (i: number, j: number): Vec2[] => [
    [x0 + i * h, y0 + j * h],
    [x0 + (i + 1) * h, y0 + j * h],
    [x0 + (i + 1) * h, y0 + (j + 1) * h],
    [x0 + i * h, y0 + (j + 1) * h],
  ];
  const touched = new Set<number>();
  ring.forEach((a, k) => {
    const b = ring[(k + 1) % ring.length] as Vec2;
    const pieces = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (h / 2)));
    for (let s = 0; s <= pieces; s++) {
      const [px, py] = [a[0] + ((b[0] - a[0]) * s) / pieces, a[1] + ((b[1] - a[1]) * s) / pieces];
      for (let i = Math.max(0, Math.floor((px - x0) / h) - 1); i <= Math.min(nx - 1, Math.floor((px - x0) / h) + 1); i++)
        for (let j = Math.max(0, Math.floor((py - y0) / h) - 1); j <= Math.min(ny - 1, Math.floor((py - y0) / h) + 1); j++)
          touched.add(i * ny + j);
    }
  });
  const quantum = h * 1e-6;
  const index = new Map<string, number>();
  const uv: Vec2[] = [];
  const vertex = (p: Vec2): number => {
    const key = `${Math.round(p[0] / quantum)},${Math.round(p[1] / quantum)}`;
    const known = index.get(key);
    if (known !== undefined) return known;
    uv.push(p);
    index.set(key, uv.length - 1);
    return uv.length - 1;
  };
  const triangles: [number, number, number][] = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      const square = cell(i, j);
      if (!touched.has(i * ny + j)) {
        const centre: Vec2 = [(square[0] as Vec2)[0] + h / 2, (square[0] as Vec2)[1] + h / 2];
        if (!pointInPolygon(centre, ring)) continue;
        const [a, b, c, d] = square.map(vertex) as [number, number, number, number];
        triangles.push([a, b, c], [a, c, d]);
        continue;
      }
      const clipped = clipToConvex(ring, square).filter(
        (p, k, all) => Math.hypot(p[0] - (all[(k + 1) % all.length] as Vec2)[0], p[1] - (all[(k + 1) % all.length] as Vec2)[1]) > quantum,
      );
      if (clipped.length < 3 || polygonArea(clipped) < h * h * 1e-9) continue;
      const local = triangulatePolygon(clipped);
      if (!local.complete) return null;
      for (const t of local.triangles) triangles.push(t.map((k) => vertex(local.vertices[k] as Vec2)) as [number, number, number]);
    }
  return triangles.length === 0 ? null : { uv, triangles: triangles.filter(([a, b, c]) => a !== b && b !== c && a !== c) };
}

/**
 * Triangulation of `outer` (counter-clockwise chart polygon) minus `holes`; when `refine` every edge is at most about `maxEdge` long.
 * @invariant conforming (no hanging nodes). Without holes a structured grid clipped by the polygon (even triangles); with holes the ear-clipped
 *   triangulation refined by Rivara longest-edge bisection (stops at 60 000 triangles)
 * @failure a polygon the ear clipper cannot triangulate -> null
 */
export function chartMesh(outer: readonly Vec2[], holes: readonly (readonly Vec2[])[], maxEdge: number, refine: boolean): ChartMesh | null {
  if (refine && holes.length === 0) return gridMesh(outer, maxEdge);
  const ring = toCounterClockwise(refine ? densify(outer, maxEdge) : outer);
  const base = triangulatePolygon(
    ring,
    holes.map((hole) => (refine ? densify(hole, maxEdge) : [...hole])),
  );
  if (!base.complete) return null;
  if (!refine) return { uv: base.vertices, triangles: base.triangles };
  const uv: Vec2[] = [...base.vertices];
  const triangles: ([number, number, number] | null)[] = base.triangles.map((t) => [...t]);
  const across = new Map<string, number[]>();
  const link = (t: number): void => {
    const tri = triangles[t] as [number, number, number];
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(tri[k] as number, tri[(k + 1) % 3] as number);
      across.set(key, [...(across.get(key) ?? []), t]);
    }
  };
  const unlink = (t: number): void => {
    const tri = triangles[t] as [number, number, number];
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(tri[k] as number, tri[(k + 1) % 3] as number);
      across.set(
        key,
        (across.get(key) ?? []).filter((other) => other !== t),
      );
    }
  };
  const pending: number[] = [];
  triangles.forEach((_, t) => {
    link(t);
    pending.push(t);
  });
  const length = (p: number, q: number): number =>
    Math.hypot((uv[p] as Vec2)[0] - (uv[q] as Vec2)[0], (uv[p] as Vec2)[1] - (uv[q] as Vec2)[1]);
  /** Index k of the longest edge (triangle vertices k -> k + 1). */
  const longest = (t: number): number => {
    const tri = triangles[t] as [number, number, number];
    let best = 0;
    for (let k = 1; k < 3; k++)
      if (length(tri[k] as number, tri[(k + 1) % 3] as number) > length(tri[best] as number, tri[(best + 1) % 3] as number) + 1e-12)
        best = k;
    return best;
  };
  const midpoints = new Map<string, number>();
  const midpoint = (p: number, q: number): number => {
    const key = edgeKey(p, q);
    const known = midpoints.get(key);
    if (known !== undefined) return known;
    const [a, b] = [uv[p] as Vec2, uv[q] as Vec2];
    uv.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    midpoints.set(key, uv.length - 1);
    return uv.length - 1;
  };
  const split = (t: number, k: number): void => {
    const tri = triangles[t] as [number, number, number];
    const [p, q, o] = [tri[k] as number, tri[(k + 1) % 3] as number, tri[(k + 2) % 3] as number];
    const r = midpoint(p, q);
    unlink(t);
    triangles[t] = null;
    for (const next of [
      [p, r, o],
      [r, q, o],
    ] as [number, number, number][]) {
      triangles.push(next);
      link(triangles.length - 1);
      pending.push(triangles.length - 1);
    }
  };
  const neighbour = (t: number, p: number, q: number): number | undefined => (across.get(edgeKey(p, q)) ?? []).find((other) => other !== t);
  const bisect = (start: number): void => {
    const t = start;
    for (let guard = 0; guard < 10_000; guard++) {
      const tri = triangles[t];
      if (tri === null || tri === undefined) return;
      const k = longest(t);
      const [p, q] = [tri[k] as number, tri[(k + 1) % 3] as number];
      const n = neighbour(t, p, q);
      if (n !== undefined && (triangles[n] as [number, number, number] | null) !== null) {
        const nk = longest(n);
        const nt = triangles[n] as [number, number, number];
        if (edgeKey(nt[nk] as number, nt[(nk + 1) % 3] as number) !== edgeKey(p, q)) {
          bisect(n);
          continue;
        }
        split(n, nk);
      }
      split(t, k);
      return;
    }
  };
  while (pending.length > 0 && triangles.length < MAX_TRIANGLES) {
    const t = pending.pop() as number;
    const tri = triangles[t];
    if (tri === null || tri === undefined) continue;
    const k = longest(t);
    if (length(tri[k] as number, tri[(k + 1) % 3] as number) <= maxEdge) continue;
    bisect(t);
    if (triangles[t] !== null) pending.push(t);
  }
  return { uv, triangles: triangles.filter((t): t is [number, number, number] => t !== null) };
}
