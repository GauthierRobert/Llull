/**
 * Analytic primitives fitted to the vertices of a triangle region (07 MSH FR-MSH-20): plane (principal axes), sphere (algebraic then
 * Levenberg-Marquardt), cylinder and cone (axis from the spread of the face normals, circle fit / tangent-plane apex, then Levenberg-Marquardt).
 * The winner is the planar fit when it is within the tolerance, else the lowest-BIC primitive within it, else `freeform`.
 * @invariant deterministic; residuals are distances of the region's vertices to the primitive, in the units of the input
 */

import type { PrimitiveFit } from '../../model/meshProvenance';
import type { Vec3 } from '../../model/vectors';
import { eigenSymmetric3, levenbergMarquardt, type Mat3, solveLinear } from './linear';

export type PrimitiveKind = Exclude<PrimitiveFit['type'], 'freeform'>;

export const PRIMITIVE_KINDS: ReadonlyArray<PrimitiveKind> = ['plane', 'cylinder', 'cone', 'sphere'];

export interface FitInput {
  readonly points: ReadonlyArray<Vec3>;
  /** Unit outward normal of every face of the region and its area (weights of the normal statistics). */
  readonly normals: ReadonlyArray<Vec3>;
  readonly areas: ReadonlyArray<number>;
  /** Centroid of every face and the mean edge length: the normals are compared with the primitive's at the centroids, in length units. */
  readonly centres?: ReadonlyArray<Vec3>;
  readonly edgeLength?: number;
}

interface Candidate {
  readonly fit: PrimitiveFit;
  readonly parameters: number;
  readonly rss: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 1];
};

function mean(points: ReadonlyArray<Vec3>): Vec3 {
  const sum = points.reduce<Vec3>((s, p) => add(s, p), [0, 0, 0]);
  return scale(sum, 1 / Math.max(points.length, 1));
}

/** Two unit vectors completing the unit `axis` to a right-handed frame. */
function frame(axis: Vec3): [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(helper, axis));
  return [u, cross(axis, u)];
}

function covariance(vectors: ReadonlyArray<Vec3>, weights: ReadonlyArray<number>, center: Vec3): Mat3 {
  const m: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  let total = 0;
  vectors.forEach((v, k) => {
    const w = weights[k] ?? 1;
    const d = sub(v, center);
    total += w;
    for (let a = 0; a < 3; a++)
      for (let b = 0; b < 3; b++) (m[a] as number[])[b] = ((m[a] as number[])[b] as number) + w * (d[a] as number) * (d[b] as number);
  });
  return m.map((row) => row.map((value) => value / Math.max(total, 1e-300))) as Mat3;
}

const rssOf = (residuals: ReadonlyArray<number>): number => residuals.reduce((s, r) => s + r * r, 0);

function planeCandidate(input: FitInput): Candidate {
  const center = mean(input.points);
  const { vectors } = eigenSymmetric3(covariance(input.points, [], center));
  let normal = vectors[0];
  const meanNormal = input.normals.reduce<Vec3>((s, n, k) => add(s, scale(n, input.areas[k] ?? 1)), [0, 0, 0]);
  if (dot(normal, meanNormal) < 0) normal = scale(normal, -1);
  const residuals = input.points.map((p) => dot(sub(p, center), normal));
  return { fit: { type: 'plane', point: center, normal, rms: 0, max: 0 }, parameters: 3, rss: rssOf(residuals) };
}

function sphereCandidate(input: FitInput): Candidate | null {
  const center0 = mean(input.points);
  const shifted = input.points.map((p) => sub(p, center0));
  const normal: number[][] = Array.from({ length: 4 }, () => new Array<number>(4).fill(0));
  const rhs = [0, 0, 0, 0];
  for (const p of shifted) {
    const row = [2 * p[0], 2 * p[1], 2 * p[2], 1];
    const target = dot(p, p);
    for (let a = 0; a < 4; a++) {
      rhs[a] = (rhs[a] as number) + (row[a] as number) * target;
      for (let b = 0; b < 4; b++)
        (normal[a] as number[])[b] = ((normal[a] as number[])[b] as number) + (row[a] as number) * (row[b] as number);
    }
  }
  const solution = solveLinear(normal, rhs);
  if (solution === null) return null;
  const c: Vec3 = [solution[0] as number, solution[1] as number, solution[2] as number];
  const r2 = (solution[3] as number) + dot(c, c);
  if (!(r2 > 0)) return null;
  const residuals = (p: ReadonlyArray<number>): number[] =>
    shifted.map((q) => Math.hypot(q[0] - (p[0] as number), q[1] - (p[1] as number), q[2] - (p[2] as number)) - (p[3] as number));
  const refined = levenbergMarquardt([c[0], c[1], c[2], Math.sqrt(r2)], residuals);
  const radius = Math.abs(refined[3] as number);
  return {
    fit: {
      type: 'sphere',
      center: add(center0, [refined[0] as number, refined[1] as number, refined[2] as number]),
      radius,
      rms: 0,
      max: 0,
    },
    parameters: 4,
    rss: rssOf(residuals(refined)),
  };
}

/** Axis direction of cylindrical / conical regions: the direction along which the face normals vary least. */
function normalAxis(input: FitInput): { axis: Vec3; meanDot: number } {
  const total = input.areas.reduce((s, w) => s + w, 0) || 1;
  const meanNormal = input.normals.reduce<Vec3>((s, n, k) => add(s, scale(n, (input.areas[k] ?? 1) / total)), [0, 0, 0]);
  const { vectors } = eigenSymmetric3(covariance(input.normals, input.areas, meanNormal));
  const axis = vectors[0];
  return { axis, meanDot: dot(meanNormal, axis) };
}

function cylinderCandidate(input: FitInput): Candidate | null {
  const { axis: axis0 } = normalAxis(input);
  const center0 = mean(input.points);
  const [u, v] = frame(axis0);
  const flat = input.points.map((p) => {
    const d = sub(p, center0);
    return [dot(d, u), dot(d, v)] as const;
  });
  const normal: number[][] = Array.from({ length: 3 }, () => new Array<number>(3).fill(0));
  const rhs = [0, 0, 0];
  for (const [x, y] of flat) {
    const row = [2 * x, 2 * y, 1];
    const target = x * x + y * y;
    for (let a = 0; a < 3; a++) {
      rhs[a] = (rhs[a] as number) + (row[a] as number) * target;
      for (let b = 0; b < 3; b++)
        (normal[a] as number[])[b] = ((normal[a] as number[])[b] as number) + (row[a] as number) * (row[b] as number);
    }
  }
  const solution = solveLinear(normal, rhs);
  if (solution === null) return null;
  const [cx, cy] = [solution[0] as number, solution[1] as number];
  const r2 = (solution[2] as number) + cx * cx + cy * cy;
  if (!(r2 > 0)) return null;
  const axisOf = (tu: number, tv: number): Vec3 => unit(add(axis0, add(scale(u, tu), scale(v, tv))));
  const residuals = (p: ReadonlyArray<number>): number[] => {
    const axis = axisOf(p[2] as number, p[3] as number);
    const origin = add(center0, add(scale(u, p[0] as number), scale(v, p[1] as number)));
    return input.points.map((q) => {
      const d = sub(q, origin);
      const along = dot(d, axis);
      return Math.hypot(...sub(d, scale(axis, along))) - (p[4] as number);
    });
  };
  const refined = levenbergMarquardt([cx, cy, 0, 0, Math.sqrt(r2)], residuals);
  const axis = axisOf(refined[2] as number, refined[3] as number);
  const origin = add(center0, add(scale(u, refined[0] as number), scale(v, refined[1] as number)));
  return {
    fit: { type: 'cylinder', axisPoint: origin, axis, radius: Math.abs(refined[4] as number), rms: 0, max: 0 },
    parameters: 5,
    rss: rssOf(residuals(refined)),
  };
}

function coneCandidate(input: FitInput): Candidate | null {
  let { axis, meanDot } = normalAxis(input);
  if (meanDot > 0) {
    axis = scale(axis, -1);
    meanDot = -meanDot;
  }
  const sinBeta = -meanDot;
  if (!(sinBeta > 2e-3 && sinBeta < 0.9998)) return null;
  const normal: number[][] = Array.from({ length: 3 }, () => new Array<number>(3).fill(0));
  const rhs = [0, 0, 0];
  const faceCenter = mean(input.points);
  input.normals.forEach((n) => {
    for (let a = 0; a < 3; a++) {
      rhs[a] = (rhs[a] as number) + (n[a] as number) * dot(n, faceCenter);
      for (let b = 0; b < 3; b++) (normal[a] as number[])[b] = ((normal[a] as number[])[b] as number) + (n[a] as number) * (n[b] as number);
    }
  });
  const apex = solveLinear(normal, rhs);
  if (apex === null) return null;
  const [u, v] = frame(axis);
  const axisOf = (tu: number, tv: number): Vec3 => unit(add(axis, add(scale(u, tu), scale(v, tv))));
  const residuals = (p: ReadonlyArray<number>): number[] => {
    const a = axisOf(p[3] as number, p[4] as number);
    const vertex: Vec3 = [p[0] as number, p[1] as number, p[2] as number];
    const beta = p[5] as number;
    return input.points.map((q) => {
      const d = sub(q, vertex);
      const z = dot(d, a);
      return Math.hypot(...sub(d, scale(a, z))) * Math.cos(beta) - z * Math.sin(beta);
    });
  };
  const refined = levenbergMarquardt([apex[0] as number, apex[1] as number, apex[2] as number, 0, 0, Math.asin(sinBeta)], residuals);
  const beta = refined[5] as number;
  if (!(beta > 0.005 && beta < Math.PI / 2 - 0.005)) return null;
  return {
    fit: {
      type: 'cone',
      apex: [refined[0] as number, refined[1] as number, refined[2] as number],
      axis: axisOf(refined[3] as number, refined[4] as number),
      halfAngleRad: beta,
      rms: 0,
      max: 0,
    },
    parameters: 6,
    rss: rssOf(residuals(refined)),
  };
}

/** Distance of `p` to the surface of `fit`. */
export function fitDistance(fit: PrimitiveFit, p: Vec3): number {
  switch (fit.type) {
    case 'plane':
      return Math.abs(dot(sub(p, fit.point), fit.normal));
    case 'sphere':
      return Math.abs(Math.hypot(...sub(p, fit.center)) - fit.radius);
    case 'cylinder': {
      const d = sub(p, fit.axisPoint);
      return Math.abs(Math.hypot(...sub(d, scale(fit.axis, dot(d, fit.axis)))) - fit.radius);
    }
    case 'cone': {
      const d = sub(p, fit.apex);
      const z = dot(d, fit.axis);
      return Math.abs(Math.hypot(...sub(d, scale(fit.axis, z))) * Math.cos(fit.halfAngleRad) - z * Math.sin(fit.halfAngleRad));
    }
    case 'freeform':
      return 0;
  }
}

/** Unit normal of the primitive at the point of its surface nearest to `p` (orientation is irrelevant to the caller). */
function surfaceNormal(fit: PrimitiveFit, p: Vec3): Vec3 | null {
  switch (fit.type) {
    case 'plane':
      return fit.normal;
    case 'sphere':
      return unit(sub(p, fit.center));
    case 'cylinder': {
      const d = sub(p, fit.axisPoint);
      return unit(sub(d, scale(fit.axis, dot(d, fit.axis))));
    }
    case 'cone': {
      const d = sub(p, fit.apex);
      const radial = unit(sub(d, scale(fit.axis, dot(d, fit.axis))));
      return unit(sub(scale(radial, Math.cos(fit.halfAngleRad)), scale(fit.axis, Math.sin(fit.halfAngleRad))));
    }
    case 'freeform':
      return null;
  }
}

/** Sum of squares of (angle between the face normal and the primitive's normal at the centroid) x edge length: separates primitives that share the vertices. */
function normalRss(fit: PrimitiveFit, input: FitInput): number {
  const { centres, edgeLength } = input;
  if (centres === undefined || edgeLength === undefined) return 0;
  return centres.reduce((sum, centre, k) => {
    const n = input.normals[k];
    const surface = surfaceNormal(fit, centre);
    if (n === undefined || surface === null) return sum;
    const angle = Math.acos(Math.min(1, Math.abs(dot(n, surface))));
    return sum + (angle * edgeLength) ** 2;
  }, 0);
}

function withResiduals(fit: PrimitiveFit, points: ReadonlyArray<Vec3>): PrimitiveFit {
  const distances = points.map((p) => fitDistance(fit, p));
  const rms = Math.sqrt(distances.reduce((s, d) => s + d * d, 0) / Math.max(distances.length, 1));
  return { ...fit, rms, max: distances.reduce((m, d) => Math.max(m, d), 0) };
}

/**
 * The primitive that describes the region best within `tolerance` (distance of the vertices), else `freeform` carrying the residual of the best
 * attempt. `kinds` restricts the candidates; a plane within tolerance always wins.
 */
export function fitRegion(input: FitInput, kinds: ReadonlyArray<PrimitiveKind>, tolerance: number): PrimitiveFit {
  const n = input.points.length;
  const candidates: Candidate[] = [];
  if (kinds.includes('plane')) candidates.push(planeCandidate(input));
  if (n >= 4) {
    if (kinds.includes('sphere')) {
      const c = sphereCandidate(input);
      if (c !== null) candidates.push(c);
    }
    if (kinds.includes('cylinder')) {
      const c = cylinderCandidate(input);
      if (c !== null) candidates.push(c);
    }
    if (kinds.includes('cone')) {
      const c = coneCandidate(input);
      if (c !== null) candidates.push(c);
    }
  }
  const measured = candidates.map((c) => ({ ...c, fit: withResiduals(c.fit, input.points) }));
  const plane = measured.find((c) => c.fit.type === 'plane');
  if (plane !== undefined && plane.fit.max <= tolerance) return plane.fit;
  const floor = Math.max(tolerance * 1e-3, 1e-12);
  const count = n + (input.centres?.length ?? 0);
  const bic = (c: Candidate & { fit: PrimitiveFit }): number =>
    count * Math.log(Math.max((c.rss + normalRss(c.fit, input)) / count, floor * floor)) + c.parameters * Math.log(Math.max(count, 2));
  const within = measured.filter((c) => c.fit.max <= tolerance).sort((a, b) => bic(a) - bic(b) || a.parameters - b.parameters);
  const winner = within[0];
  if (winner !== undefined) return winner.fit;
  const nearest = [...measured].sort((a, b) => a.fit.max - b.fit.max)[0];
  return { type: 'freeform', rms: nearest?.fit.rms ?? 0, max: nearest?.fit.max ?? 0 };
}
