// Shared helpers for the oracle case files: a case = plan actions + closed-form expectation.
import { PI } from './formulas.mjs';

/** All kernels that must reproduce the case. Mesh kernels (Manifold) only run cases that need no exact B-rep. */
export const BOTH = ['manifold', 'occt'];
export const EXACT_ONLY = ['occt'];

const round = (x) => (x === null ? null : Number(x.toPrecision(12)));
const round3 = (v) => v.map((x) => (Math.abs(x) < 1e-12 ? 0 : round(x)));

/**
 * Manifold's default circle resolution (minCircularAngle 10 deg, minCircularEdgeLength 1): ceil(min(36, 2 pi r)) segments rounded up to a
 * multiple of 4. Used to bound the error of an inscribed polygon in mesh-kernel results.
 */
export function circleSegments(radius) {
  const n = Math.max(3, Math.ceil(Math.min(36, 2 * PI * radius)));
  return Math.ceil(n / 4) * 4;
}

/** Relative area loss of a regular n-gon inscribed in a circle (also bounds the volume loss of a prism on it). */
export const polygonLoss = (radius) => {
  const n = circleSegments(radius);
  return 1 - (n * Math.sin((2 * PI) / n)) / (2 * PI);
};

/** Sphere tessellation envelope: Manifold builds spheres with 32 segments; measured volume loss is about 2 %, bounded at 3 %. */
export const SPHERE_LOSS = 0.03;

/**
 * @param {Array} out accumulator
 * @param {object} c family, name, description, formula, actions, p (part from formulas.mjs), kernels, faces, mesh, centroid (false to skip), bodies
 */
export function addCase(out, c) {
  const id = `${String(out.length + 1).padStart(2, '0')}-${c.name}`;
  const expected = {
    id,
    family: c.family,
    description: c.description,
    source: 'analytic',
    formula: c.formula,
    kernels: c.kernels ?? BOTH,
    bodies: c.bodies ?? 1,
    volume: round(c.p.v),
    area: c.area === undefined ? round(c.p.a) : round(c.area),
    centroid: c.centroid === false ? null : round3(c.p.c),
    bbox: c.p.min === null ? null : { min: round3(c.p.min), max: round3(c.p.max) },
    ...(c.faces === undefined ? {} : { faces: c.faces }),
    tolerance: { volume: 1e-3, area: 1e-3, centroid: 1e-3, bbox: 1e-3, ...c.tolerance },
    ...(c.mesh === undefined ? {} : { meshTolerance: c.mesh }),
    ...(c.stepRoundTrip === false ? { stepRoundTrip: false } : {}),
    ...(c.knownFailure === undefined ? {} : { knownFailure: c.knownFailure }),
  };
  out.push({ id, plan: { actions: c.actions }, expected });
}

/** meshTolerance object: relative volume/area, centroid/bbox in units of the part size (see oracle runner). */
export const mesh = (volume, area, reason, extra = {}) => ({ volume, area, reason, ...extra });

/** Rigorous bound on the relative loss of a feature whose cross-section is an inscribed n-gon: the polygon contains the circle of radius r cos(pi/n), so volume ~ r^k loses at most k (1 - cos(pi/n)). frac = feature share of the result. */
export const cylTol = (r, frac, k = 2) => k * (1 - Math.cos(Math.PI / circleSegments(r))) * frac;

/** Same for a sphere feature (envelope SPHERE_LOSS of its own volume). */
export const sphTol = (frac) => SPHERE_LOSS * frac;
