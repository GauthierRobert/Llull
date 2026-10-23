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

/** Parameters of one direction: every knot of a degree-1 direction, else `count` uniform samples; the last is included when `end`. */
function parameters(knots: ReadonlyArray<number>, degree: number, perSpan: number, end: boolean): number[] {
  const values: number[] = [];
  for (let span = 0; span + 1 < knots.length; span++) {
    const steps = degree === 1 ? 1 : perSpan;
    for (let s = 0; s < steps; s++)
      values.push((knots[span] as number) + (((knots[span + 1] as number) - (knots[span] as number)) * s) / steps);
  }
  if (end) values.push(knots[knots.length - 1] as number);
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
  const columns = faces.flatMap((face) => parameters(face.knotsU, face.degreeU, perSpan, false).map((u) => ({ face, u })));
  return (closed ? vs.slice(0, -1) : vs).map((v) => columns.map(({ face, u }) => evaluateSurface(face, u, v)));
}
