import type { FramePoint } from './types';

export interface BendGeometry {
  /** Points from the near tangent point to the far tangent point (nSub + 1 of them); chord elements join consecutive points. */
  readonly points: readonly FramePoint[];
  /** Deflection angle theta (rad) between the incoming and outgoing travel directions. */
  readonly angle: number;
  /** Tangent length R tan(theta / 2): how far the legs are shortened from the sharp corner. */
  readonly tangentLength: number;
  /** Arc centre. */
  readonly centre: FramePoint;
}

const DEGREE = Math.PI / 180;

/** Number of straight sub-elements for a bend of deflection `angle`: max(2, ceil(angle / 7.5 deg)); 7.5 deg (not the spec 15 deg, which leaves 1.9e-3) keeps a 90 deg bend within 1e-3 of the curved-beam flexibility. */
export function bendSubdivisions(angle: number): number {
  return Math.max(2, Math.ceil(angle / (7.5 * DEGREE) - 1e-9));
}

/**
 * Circular bend of radius `radius` replacing the sharp corner `corner` between legs travelled along unit directions `incoming`
 * then `outgoing`. Returns null for a straight continuation (no bend), a near reversal (theta > pi - 0.05 rad) or non-finite input.
 * The caller must check that each leg is at least `tangentLength` long (else the bend does not fit).
 * Interior points lie on the arc; chord elements carry the bend flexibility factor k (stiffness EI / k).
 */
export function bendChords(
  corner: FramePoint,
  incoming: FramePoint,
  outgoing: FramePoint,
  radius: number,
  subdivisions?: number,
): BendGeometry | null {
  const cos = incoming[0] * outgoing[0] + incoming[1] * outgoing[1] + incoming[2] * outgoing[2];
  if (![...corner, ...incoming, ...outgoing, radius, cos].every(Number.isFinite) || !(radius > 0)) return null;
  const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
  if (angle < 1e-6 || angle > Math.PI - 0.05) return null;
  // n: unit vector in the bend plane, perpendicular to `incoming`, pointing toward the centre.
  const raw: FramePoint = [outgoing[0] - cos * incoming[0], outgoing[1] - cos * incoming[1], outgoing[2] - cos * incoming[2]];
  const length = Math.hypot(raw[0], raw[1], raw[2]);
  const n: FramePoint = [raw[0] / length, raw[1] / length, raw[2] / length];
  const tangentLength = radius * Math.tan(angle / 2);
  const near: FramePoint = [
    corner[0] - incoming[0] * tangentLength,
    corner[1] - incoming[1] * tangentLength,
    corner[2] - incoming[2] * tangentLength,
  ];
  const centre: FramePoint = [near[0] + n[0] * radius, near[1] + n[1] * radius, near[2] + n[2] * radius];
  const count = Math.max(1, Math.floor(subdivisions ?? bendSubdivisions(angle)));
  const points: FramePoint[] = [];
  for (let i = 0; i <= count; i++) {
    const a = (angle * i) / count;
    const c = Math.cos(a);
    const s = Math.sin(a);
    points.push([
      centre[0] + radius * (-n[0] * c + incoming[0] * s),
      centre[1] + radius * (-n[1] * c + incoming[1] * s),
      centre[2] + radius * (-n[2] * c + incoming[2] * s),
    ]);
  }
  return { points, angle, tangentLength, centre };
}
