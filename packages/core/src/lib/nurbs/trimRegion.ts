/** Trimmed-sheet regions in the (u, v) plane (02 SRF): membership, loop crossings and the exact area of the trimmed surface (Green's theorem). */

import type { Vec3 } from '../../model/vectors';
import { cross3, len3 } from '../vec3';
import { pointInPolygon, segmentsIntersect } from '../polygon';
import { surfaceDerivatives, surfaceDomain } from './surface';
import type { NurbsSurfaceData, UvTrimLoop } from './surfaceTypes';

type Uv = readonly [number, number];

const asPoint = (uv: Uv): [number, number] => [uv[0], uv[1]];

/** Even-odd membership test of the region bounded by `loops`: the polygons are converted and boxed once, then each query only reads the loops whose box holds the point. */
export function regionTester(loops: ReadonlyArray<UvTrimLoop>): (point: Uv) => boolean {
  const prepared = loops.map((loop) => {
    const polygon = loop.polygon.map(asPoint);
    return {
      polygon,
      uMin: Math.min(...polygon.map((p) => p[0])),
      uMax: Math.max(...polygon.map((p) => p[0])),
      vMin: Math.min(...polygon.map((p) => p[1])),
      vMax: Math.max(...polygon.map((p) => p[1])),
    };
  });
  return (point) => {
    let inside = false;
    for (const box of prepared)
      if (
        point[0] >= box.uMin &&
        point[0] <= box.uMax &&
        point[1] >= box.vMin &&
        point[1] <= box.vMax &&
        pointInPolygon(asPoint(point), box.polygon)
      )
        inside = !inside;
    return inside;
  };
}

/** Even-odd membership of `point` in the region bounded by `loops` (one-off form of `regionTester`). */
export function insideRegion(loops: ReadonlyArray<UvTrimLoop>, point: Uv): boolean {
  return regionTester(loops)(point);
}

/** True when an edge of polygon `a` crosses an edge of polygon `b`. */
export function loopsCross(a: ReadonlyArray<Uv>, b: ReadonlyArray<Uv>): boolean {
  for (let i = 0; i < a.length; i++) {
    const [p, q] = [a[i] as Uv, a[(i + 1) % a.length] as Uv];
    for (let j = 0; j < b.length; j++)
      if (segmentsIntersect(asPoint(p), asPoint(q), asPoint(b[j] as Uv), asPoint(b[(j + 1) % b.length] as Uv))) return true;
  }
  return false;
}

/** The rectangle of the whole parameter domain as an outer loop: corners at even indices, a midpoint between them. */
export function domainLoop(surface: NurbsSurfaceData): UvTrimLoop {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const corners: Uv[] = [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ];
  const polygon = corners.flatMap((corner, i) => {
    const next = corners[(i + 1) % 4] as Uv;
    return [corner, [(corner[0] + next[0]) / 2, (corner[1] + next[1]) / 2] as Uv];
  });
  return { outer: true, polygon };
}

const GAUSS_6: ReadonlyArray<readonly [number, number]> = [
  [-0.9324695142031521, 0.1713244923791704],
  [-0.6612093864662645, 0.3607615730481386],
  [-0.2386191860831969, 0.467913934572691],
  [0.2386191860831969, 0.467913934572691],
  [0.6612093864662645, 0.3607615730481386],
  [0.9324695142031521, 0.1713244923791704],
];
const GAUSS_3: ReadonlyArray<readonly [number, number]> = [
  [-0.7745966692414834, 5 / 9],
  [0, 8 / 9],
  [0.7745966692414834, 5 / 9],
];

/** Longest piece (relative to the domain size) of a polygon edge before the 3-point rule is applied to it. */
const MAX_PIECE = 1 / 16;

/** Area density |S_u x S_v| at (u, v). */
function density(surface: NurbsSurfaceData, u: number, v: number): number {
  const d = surfaceDerivatives(surface, u, v, 1);
  return len3(cross3((d[1] as Vec3[])[0] as Vec3, (d[0] as Vec3[])[1] as Vec3));
}

/** F(u, v) = integral of the area density from the lowest u to `u` along the iso-v line (Gauss-Legendre per knot span). */
function inner(surface: NurbsSurfaceData, u: number, v: number): number {
  let sum = 0;
  const knots = surface.knotsU;
  for (let k = 0; k + 1 < knots.length; k++) {
    const [a, b] = [knots[k] as number, Math.min(knots[k + 1] as number, u)];
    if (b <= a) break;
    const [half, mid] = [(b - a) / 2, (a + b) / 2];
    for (const [node, weight] of GAUSS_6) sum += weight * half * density(surface, mid + half * node, v);
  }
  return sum;
}

/** Signed integral of F dv around `polygon` (counter-clockwise gives the area integral of the density inside). */
function loopIntegral(surface: NurbsSurfaceData, polygon: ReadonlyArray<Uv>, reach: number): number {
  let total = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [a, b] = [polygon[i] as Uv, polygon[(i + 1) % polygon.length] as Uv];
    const dv = b[1] - a[1];
    if (dv === 0) continue;
    const pieces = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(dv)) / (MAX_PIECE * reach)));
    for (let piece = 0; piece < pieces; piece++) {
      const [t0, t1] = [piece / pieces, (piece + 1) / pieces];
      const half = (t1 - t0) / 2;
      for (const [node, weight] of GAUSS_3) {
        const t = (t0 + t1) / 2 + half * node;
        total += weight * half * dv * inner(surface, a[0] + t * (b[0] - a[0]), a[1] + t * dv);
      }
    }
  }
  return total;
}

/**
 * Surface area of the trimmed sheet: for every loop the integral of |S_u x S_v| over its interior by Green's theorem (inner Gauss quadrature,
 * boundary Gauss quadrature per polygon edge), Richardson-extrapolated between the polygon and its even-index decimation (error O(h^4) of the
 * boundary sampling); holes are subtracted.
 */
export function trimmedArea(surface: NurbsSurfaceData, loops: ReadonlyArray<UvTrimLoop>): number {
  const reach = Math.max(
    (surface.knotsU[surface.knotsU.length - 1] as number) - (surface.knotsU[0] as number),
    (surface.knotsV[surface.knotsV.length - 1] as number) - (surface.knotsV[0] as number),
  );
  return loops.reduce((sum, loop) => {
    const fine = Math.abs(loopIntegral(surface, loop.polygon, reach));
    const refine = loop.polygon.length >= 8;
    const coarse = refine
      ? Math.abs(
          loopIntegral(
            surface,
            loop.polygon.filter((_, index) => index % 2 === 0),
            reach,
          ),
        )
      : fine;
    const value = refine ? (4 * fine - coarse) / 3 : fine;
    return sum + (loop.outer ? value : -value);
  }, 0);
}
