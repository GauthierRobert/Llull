/** Dense rings sampled from the faces of an advanced loft: the display / Manifold fallback of the exact skin (a ruled skin yields its sections exactly). */

import type { Vec3 } from '../../model/vectors';
import { evaluateSurface } from '../../lib/nurbs/surface';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';

/** Ring points wanted around one section (spread over its knot spans). */
const RING_POINTS = 48;
const MIN_RINGS = 17;
const MAX_RINGS = 65;
const RINGS_PER_INTERVAL = 8;
const RULED_SUBRINGS = 8;
/** Display points per knot span of a straight (degree 1) section direction whose ruled quads twist: they are then small enough for the mesh volume to hold. */
const TWISTED_STEPS = 16;
/** A quad whose corners span a tetrahedron of more than this fraction of (largest side)^3 is twisted (not planar). */
const PLANAR_TOLERANCE = 1e-9;

const point = (face: NurbsSurfaceData, u: number, v: number): Vec3 => evaluateSurface(face, u, v);

/** True when the ruled quads of the straight span `[u0, u1]` stay planar between every pair of neighbouring v knots (a prism wall, not a twisted ruling). */
function planarSpan(face: NurbsSurfaceData, u0: number, u1: number): boolean {
  for (let i = 0; i + 1 < face.knotsV.length; i++) {
    const [v0, v1] = [face.knotsV[i] as number, face.knotsV[i + 1] as number];
    const [a, b, c, d] = [point(face, u0, v0), point(face, u1, v0), point(face, u0, v1), point(face, u1, v1)];
    const sub = (p: Vec3, q: Vec3): Vec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    const [ab, ac, ad] = [sub(b, a), sub(c, a), sub(d, a)];
    const volume =
      ab[0] * (ac[1] * ad[2] - ac[2] * ad[1]) - ab[1] * (ac[0] * ad[2] - ac[2] * ad[0]) + ab[2] * (ac[0] * ad[1] - ac[1] * ad[0]);
    const side = Math.max(Math.hypot(...ab), Math.hypot(...ac), Math.hypot(...ad), 1e-12);
    if (Math.abs(volume) > PLANAR_TOLERANCE * side ** 3) return false;
  }
  return true;
}

/** u parameters of a face's display ring: `perSpan` uniform samples per curved span; a straight span of a ruled skin has TWISTED_STEPS when its quads twist, else its knot only. */
function parameters(face: NurbsSurfaceData, perSpan: number, ruled: boolean): number[] {
  const knots = face.knotsU;
  const values: number[] = [];
  for (let span = 0; span + 1 < knots.length; span++) {
    const [u0, u1] = [knots[span] as number, knots[span + 1] as number];
    const steps = face.degreeU === 1 ? (ruled && !planarSpan(face, u0, u1) ? TWISTED_STEPS : 1) : perSpan;
    for (let s = 0; s < steps; s++) values.push(u0 + ((u1 - u0) * s) / steps);
  }
  return values;
}

/** The knots with `RULED_SUBRINGS` equal steps inside each interval: a ruled skin is linear between sections, so extra rings lie on the rulings and thin the display quads. */
function subdivided(knots: ReadonlyArray<number>): number[] {
  const values: number[] = [];
  for (let i = 0; i + 1 < knots.length; i++)
    for (let s = 0; s < RULED_SUBRINGS; s++)
      values.push((knots[i] as number) + (((knots[i + 1] as number) - (knots[i] as number)) * s) / RULED_SUBRINGS);
  values.push(knots[knots.length - 1] as number);
  return values;
}

/**
 * Rings through the faces of a loft of `sectionCount` sections: each ring joins the faces' u samples (corners are sample points), rings sit at
 * the sections when the skin is ruled, else at 8 per section interval (17..65).
 */
export function displayRings(faces: ReadonlyArray<NurbsSurfaceData>, sectionCount: number, closed: boolean): Vec3[][] {
  const first = faces[0] as NurbsSurfaceData;
  const totalSpans = faces.reduce((sum, face) => sum + face.knotsU.length - 1, 0);
  const perSpan = Math.max(3, Math.min(16, Math.ceil(RING_POINTS / totalSpans)));
  const ruled = faces.every((face) => face.degreeV === 1);
  const count = Math.max(MIN_RINGS, Math.min(MAX_RINGS, RINGS_PER_INTERVAL * (sectionCount - 1) + 1));
  const vs = ruled ? subdivided(first.knotsV) : Array.from({ length: count }, (_, k) => k / (count - 1));
  const columns = faces.flatMap((face) => parameters(face, perSpan, ruled).map((u) => ({ face, u })));
  return (closed ? vs.slice(0, -1) : vs).map((v) => columns.map(({ face, u }) => evaluateSurface(face, u, v)));
}
