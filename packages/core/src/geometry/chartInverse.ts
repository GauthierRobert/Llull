/**
 * The chart coordinates of a 3D point of a face (03 WRP, `create_curve_on_face`): where the geodesic from the chart anchor to the point ends in the chart, so the straight chart
 * line from the anchor to it is the geodesic. Develop charts: the development (cylinder: shortest turn; cone: the sector, refused through the apex). Sphere: the great circle.
 * Torus: a geodesic found by Newton shooting from the straight (u, v) guess. The chart must have been built with placement angle 0, no mirror and the anchor at the origin.
 * @failure a point on the cone apex or a segment through it, a sphere point beyond the chart reach (about a quarter great circle) or equal to the anchor, a torus shooting
 *   that does not converge -> `{ error }`
 */

import type { Vec2, Vec3 } from '../model/vectors';
import { cross3, dot3, normalize3, sub3 } from '../lib/vec3';
import type { FaceChart } from './chartFrame';
import { torusGeodesicEnd } from './curvedChart';

type Inverse = Vec2 | { readonly error: string };

const TWO_PI = 2 * Math.PI;
const wrapPi = (angle: number): number => angle - TWO_PI * Math.round(angle / TWO_PI);
const REACH = 0.98 * (Math.PI / 2);

function coneInverse(chart: FaceChart, target: Vec3): Inverse {
  const alpha = chart.wire.data[9] as number;
  const sin = Math.sin(alpha);
  const [u0, rho0] = chart.anchorUv;
  const [uB, rhoB] = chart.uvOfPoint(target);
  if (!(rhoB > 1e-9)) return { error: 'the end point is the cone apex' };
  const phi0 = u0 * sin;
  const phiB = phi0 + wrapPi(uB - u0) * sin;
  const radial: Vec2 = [Math.cos(phi0), Math.sin(phi0)];
  const tangent: Vec2 = [-Math.sin(phi0), Math.cos(phi0)];
  const d: Vec2 = [rhoB * Math.cos(phiB) - rho0 * radial[0], rhoB * Math.sin(phiB) - rho0 * radial[1]];
  const along = d[0] * tangent[0] + d[1] * tangent[1];
  const across = d[0] * radial[0] + d[1] * radial[1];
  // distance of the apex (the development's origin) from the segment F0 -> F0 + d
  const start: Vec2 = [rho0 * radial[0], rho0 * radial[1]];
  const length2 = d[0] * d[0] + d[1] * d[1];
  const s = length2 > 0 ? Math.max(0, Math.min(1, -(start[0] * d[0] + start[1] * d[1]) / length2)) : 0;
  if (Math.hypot(start[0] + s * d[0], start[1] + s * d[1]) < 1e-9 * Math.max(rho0, rhoB))
    return { error: 'the geodesic passes through the cone apex' };
  return [along, across];
}

function sphereInverse(chart: FaceChart, target: Vec3): Inverse {
  const data = chart.wire.data;
  const radius = data[9] as number;
  const centre: Vec3 = [data[0] as number, data[1] as number, data[2] as number];
  const north: Vec3 = [data[3] as number, data[4] as number, data[5] as number];
  const anchor: Vec3 = [data[6] as number, data[7] as number, data[8] as number];
  const east = cross3(north, anchor);
  const b = normalize3(sub3(target, centre));
  const cos = Math.max(-1, Math.min(1, dot3(anchor, b)));
  const angle = Math.acos(cos);
  if (angle < 1e-12) return { error: 'the two points coincide' };
  if (angle > REACH) return { error: 'the points are further apart than a quarter great circle; split the geodesic in shorter pieces' };
  const tangent: Vec3 = [b[0] - cos * anchor[0], b[1] - cos * anchor[1], b[2] - cos * anchor[2]];
  const psi = Math.atan2(dot3(tangent, north), dot3(tangent, east));
  const rho = radius * angle;
  return [rho * Math.cos(psi), rho * Math.sin(psi)];
}

function torusInverse(chart: FaceChart, target: Vec3): Inverse {
  const major = chart.wire.data[9] as number;
  const minor = chart.wire.data[10] as number;
  const [, v0] = chart.anchorUv;
  const [uB, vB] = chart.uvOfPoint(target);
  const ring = major + minor * Math.cos(v0);
  const du = wrapPi(uB);
  const dv = wrapPi(vB - v0);
  let psi = Math.atan2(dv * minor, du * ring);
  let rho = Math.hypot(du * ring, dv * minor);
  if (rho < 1e-12) return { error: 'the two points coincide' };
  const miss = (p: number, r: number): Vec2 => {
    const [u, v] = torusGeodesicEnd(major, minor, v0, p, r);
    return [u - du, v - (v0 + dv)];
  };
  for (let iteration = 0; iteration < 60; iteration++) {
    const f = miss(psi, rho);
    if (Math.hypot(f[0] * ring, f[1] * minor) < 1e-10 * Math.max(1, rho)) return [rho * Math.cos(psi), rho * Math.sin(psi)];
    const h = 1e-7;
    const fp = miss(psi + h, rho);
    const fr = miss(psi, rho + h);
    const a = (fp[0] - f[0]) / h;
    const b = (fr[0] - f[0]) / h;
    const c = (fp[1] - f[1]) / h;
    const d = (fr[1] - f[1]) / h;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-14) break;
    const [stepPsi, stepRho] = [(d * f[0] - b * f[1]) / det, (-c * f[0] + a * f[1]) / det];
    psi -= Math.max(-0.5, Math.min(0.5, stepPsi));
    rho = Math.max(1e-9, rho - Math.max(-0.5 * rho, Math.min(0.5 * rho, stepRho)));
  }
  return { error: 'the geodesic shooting did not converge' };
}

export function chartPointOf(chart: FaceChart, target: Vec3): Inverse {
  switch (chart.kind) {
    case 'plane': {
      const [u, v] = chart.uvOfPoint(target);
      return [u - chart.anchorUv[0], v - chart.anchorUv[1]];
    }
    case 'cylinder': {
      const [u, v] = chart.uvOfPoint(target);
      return [wrapPi(u - chart.anchorUv[0]) * (chart.wire.data[9] as number), v - chart.anchorUv[1]];
    }
    case 'cone':
      return coneInverse(chart, target);
    case 'sphere':
      return sphereInverse(chart, target);
    case 'torus':
      return torusInverse(chart, target);
  }
}
