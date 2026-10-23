/** Exact volume of a faceted-skin loft (SWG M5): divergence theorem on the NURBS faces plus the planar end caps, no kernel needed. */
import type { LoftEntity, Vec3 } from '@core/model/types';
import { add3, cross3, dot3, scale3, sub3 } from '@lib/vec3';
import { surfaceDerivatives, surfaceDomain } from '@lib/nurbs/surface';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';

const GAUSS: ReadonlyArray<readonly [number, number]> = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];

const pointOf = (face: NurbsSurfaceData, u: number, v: number): Vec3 => (surfaceDerivatives(face, u, v, 0)[0] as Vec3[])[0] as Vec3;
const centre = (ring: readonly Vec3[]): Vec3 =>
  scale3(
    ring.reduce((s, p) => add3(s, p), [0, 0, 0] as Vec3),
    1 / ring.length,
  );

/** (1/3) integral of S . (S_u x S_v) over the whole domain of a face (raw orientation), composite Gauss with 4 pieces per knot span. */
function fluxOf(face: NurbsSurfaceData): number {
  const breaks = (knots: ReadonlyArray<number>): Array<[number, number]> =>
    knots.slice(1).flatMap((hi, k) =>
      Array.from({ length: 12 }, (_, p): [number, number] => {
        const lo = knots[k] as number;
        return [lo + ((hi - lo) * p) / 12, lo + ((hi - lo) * (p + 1)) / 12];
      }),
    );
  let total = 0;
  for (const [a0, a1] of breaks(face.knotsU))
    for (const [b0, b1] of breaks(face.knotsV))
      for (const [xu, wu] of GAUSS)
        for (const [xv, wv] of GAUSS) {
          const u = (a0 + a1) / 2 + ((a1 - a0) / 2) * xu;
          const v = (b0 + b1) / 2 + ((b1 - b0) / 2) * xv;
          const d = surfaceDerivatives(face, u, v, 1);
          const normal = cross3((d[1] as Vec3[])[0] as Vec3, (d[0] as Vec3[])[1] as Vec3);
          total += wu * wv * ((a1 - a0) / 2) * ((b1 - b0) / 2) * dot3((d[0] as Vec3[])[0] as Vec3, normal);
        }
  return total / 3;
}

/** Boundary polyline of the faces at the first (`end` false) or last v. */
function boundary(faces: readonly NurbsSurfaceData[], end: boolean): Vec3[] {
  return faces.flatMap((face) => {
    const [[u0, u1], [v0, v1]] = surfaceDomain(face);
    const spans = face.knotsU.length - 1;
    const n = Math.max(1, Math.ceil(20000 / spans));
    return Array.from({ length: spans * n }, (_, k) => {
      const span = Math.floor(k / n);
      const a = face.knotsU[span] as number;
      const b = face.knotsU[span + 1] as number;
      return pointOf(face, Math.min(u1, Math.max(u0, a + ((b - a) * (k % n)) / n)), end ? v1 : v0);
    });
  });
}

/** Area vector of a closed polyline (half the sum of cross products about its first point). */
function areaVector(ring: readonly Vec3[]): Vec3 {
  const o = ring[0] as Vec3;
  let sum: Vec3 = [0, 0, 0];
  for (let i = 1; i + 1 < ring.length; i++) sum = add3(sum, cross3(sub3(ring[i] as Vec3, o), sub3(ring[i + 1] as Vec3, o)));
  return scale3(sum, 0.5);
}

/** Volume of a solid loft with `faces` (local): lateral faces by the divergence theorem plus the two planar caps (none when `closed`). */
export function loftFacesVolume(loft: Pick<LoftEntity, 'faces' | 'closed'>): number {
  const faces = loft.faces ?? [];
  const lateral = faces.reduce((sum, face) => sum + fluxOf(face), 0);
  if (loft.closed === true) return Math.abs(lateral);
  const [bottom, top] = [boundary(faces, false), boundary(faces, true)];
  const travel = sub3(centre(top), centre(bottom));
  const capFlux = (ring: readonly Vec3[], outward: Vec3): number => {
    const area = areaVector(ring);
    return ((dot3(area, outward) >= 0 ? 1 : -1) * dot3(area, ring[0] as Vec3)) / 3;
  };
  // the sign of the lateral flux: outward is away from the centroid of the ring at the same v
  const first = faces[0] as NurbsSurfaceData;
  const [[u0, u1], [v0, v1]] = surfaceDomain(first);
  const v = (v0 + v1) / 2;
  const ring = Array.from({ length: 16 }, (_, k) => pointOf(first, u0 + ((u1 - u0) * k) / 16, v));
  const d = surfaceDerivatives(first, u0, v, 1);
  const outward = dot3(cross3((d[1] as Vec3[])[0] as Vec3, (d[0] as Vec3[])[1] as Vec3), sub3(ring[0] as Vec3, centre(ring))) >= 0 ? 1 : -1;
  return outward * lateral + capFlux(bottom, scale3(travel, -1)) + capFlux(top, travel);
}
