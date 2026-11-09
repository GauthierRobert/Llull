/**
 * Bearing pressure of a pin on a hole wall (PHY-06 FR-CNT-11), from the nodal contact pressures of the hole-wall nodes: the angular distribution about the
 * pin axis, the contact half-angle, the resultant force on the plate and the hoop stress at the wall. Pure; analysis units.
 */

import type { Vec3 } from '@core/model/vectors';
import { cross3, dot3, scale3, sub3 } from '@lib/vec3';

export interface WallNode {
  readonly node: number;
  readonly at: Vec3;
  /** Tributary area of the node on the hole wall. */
  readonly area: number;
  /** Contact pressure (>= 0), 0 when open. */
  readonly pressure: number;
  /** Stress tensor [sxx, syy, szz, sxy, syz, szx] at the node, when the results hold it. */
  readonly stress: readonly number[] | null;
}

export interface AxisFrame {
  readonly origin: Vec3;
  /** Unit axis of the hole. */
  readonly axis: Vec3;
  /** Unit vector perpendicular to the axis: the direction of the pin load on the plate (angle 0). */
  readonly reference: Vec3;
}

interface BearingRow {
  readonly node: number;
  /** Angle from the load direction, degrees in (-180, 180], positive about the axis (right-hand rule). */
  readonly angleDeg: number;
  readonly radius: number;
  readonly pressure: number;
  /** Hoop stress sigma_theta at the node, when it has a stress tensor. */
  readonly hoopStress: number | null;
}

export interface Bearing {
  readonly rows: readonly BearingRow[];
  readonly peak: { readonly pressure: number; readonly node: number; readonly angleDeg: number } | null;
  /** Largest |angle| of a node in contact: half the contact arc (the sampling step of the mesh bounds its accuracy). */
  readonly halfAngleDeg: number | null;
  /** Resultant of pressure x area x outward radial direction: its component along the load direction, across it, and the contact (normal) force sum. */
  readonly resultant: { readonly along: number; readonly across: number; readonly normalForce: number };
  readonly maxHoop: { readonly stress: number; readonly node: number; readonly angleDeg: number } | null;
}

/** Frame with the reference direction made perpendicular to the axis, or null when the axis or the direction is zero / parallel. */
export function axisFrame(origin: Vec3, axis: Vec3, direction: Vec3): AxisFrame | null {
  const length = Math.hypot(...axis);
  if (!(length > 0)) return null;
  const unit = scale3(axis, 1 / length);
  const across = sub3(direction, scale3(unit, dot3(direction, unit)));
  const size = Math.hypot(...across);
  if (!(size > 1e-12 * Math.max(1, Math.hypot(...direction)))) return null;
  return { origin, axis: unit, reference: scale3(across, 1 / size) };
}

/** sigma_theta = e . S . e for the unit hoop direction `e` and S = [sxx, syy, szz, sxy, syz, szx]. */
const hoopOf = (stress: readonly number[], e: Vec3): number => {
  const [sxx = 0, syy = 0, szz = 0, sxy = 0, syz = 0, szx = 0] = stress;
  return sxx * e[0] * e[0] + syy * e[1] * e[1] + szz * e[2] * e[2] + 2 * (sxy * e[0] * e[1] + syz * e[1] * e[2] + szx * e[2] * e[0]);
};

/**
 * Angular bearing distribution of `nodes` about `frame`.
 * @invariant a node on the axis (radius 0) is skipped; rows sorted by angle; resultant.along equals P for a hole loaded by a pin force P along the reference direction
 */
export function bearingOf(frame: AxisFrame, nodes: readonly WallNode[]): Bearing {
  const second = cross3(frame.axis, frame.reference);
  const rows: BearingRow[] = [];
  let along = 0;
  let across = 0;
  let normalForce = 0;
  let peak: Bearing['peak'] = null;
  let half: number | null = null;
  let hoop: Bearing['maxHoop'] = null;
  for (const wall of nodes) {
    const rel = sub3(wall.at, frame.origin);
    const radial = sub3(rel, scale3(frame.axis, dot3(rel, frame.axis)));
    const radius = Math.hypot(...radial);
    if (!(radius > 0)) continue;
    const outward = scale3(radial, 1 / radius);
    const angleDeg = (Math.atan2(dot3(outward, second), dot3(outward, frame.reference)) * 180) / Math.PI;
    const hoopStress = wall.stress === null ? null : hoopOf(wall.stress, cross3(frame.axis, outward));
    rows.push({ node: wall.node, angleDeg, radius, pressure: wall.pressure, hoopStress });
    const force = wall.pressure * wall.area;
    along += force * dot3(outward, frame.reference);
    across += force * dot3(outward, second);
    normalForce += force;
    if (wall.pressure > 0) {
      half = Math.max(half ?? 0, Math.abs(angleDeg));
      if (peak === null || wall.pressure > peak.pressure) peak = { pressure: wall.pressure, node: wall.node, angleDeg };
    }
    if (hoopStress !== null && (hoop === null || hoopStress > hoop.stress)) hoop = { stress: hoopStress, node: wall.node, angleDeg };
  }
  rows.sort((a, b) => a.angleDeg - b.angleDeg || a.node - b.node);
  return { rows, peak, halfAngleDeg: half, resultant: { along, across, normalForce }, maxHoop: hoop };
}
