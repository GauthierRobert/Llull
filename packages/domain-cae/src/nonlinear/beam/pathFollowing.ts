/**
 * PHY-05 TR-NLS-20 path following on a corotational frame: spherical arc-length (psi = 0, predictor along the tangent with the sign of the
 * previous increment, the corrector root closest to the previous direction) and load-control Newton, as `arclength` /
 * `corotational_cantilever` of validation/generate_nls_reference.py.
 */

import { assemble, factor, maxDiagonal, solve, type FrameModel } from './frameModel';

/** Element i of a numeric array; 0 for an index past the end (noUncheckedIndexedAccess identity, never an engineering default). */
const at = (values: ArrayLike<number>, index: number): number => values[index] ?? 0;

/** Newton / corrector iterations per step before the step counts as not converged. */
export const MAX_ITERATIONS = 60;
/** Residual norm below RESIDUAL_TOLERANCE x max(1, |lambda| x |reference load|) = equilibrium. */
export const RESIDUAL_TOLERANCE = 1e-9;
/**
 * A correction smaller than STAGNATION x the size of the step increment also ends the iterations (llull addition, not in the generator): on
 * fine frames (~1000 elements) rounding keeps the residual just above the absolute tolerance; the generator cases converge on the residual first.
 */
const STAGNATION = 1e-12;

/**
 * The unloaded frame is a mechanism when |K^-1 Pref| x max|K_ii| / |Pref| exceeds this (a rigid-body mode survives rounding as a huge but
 * finite compliance; slender real frames stay below about 1e9).
 */
const MECHANISM_COMPLIANCE = 1e12;

export interface PathPoint {
  readonly loadFactor: number;
  /** Global displacements (3 per node: ux, uy, rz). */
  readonly u: Float64Array;
}

/** Why a step failed: no real root of the arc-length constraint, a singular tangent at the start of the step or in the corrector, or the iteration cap. */
export type StepFailure = 'no_real_root' | 'singular_tangent' | 'singular_corrector' | 'iterations';

export type PathResult =
  | { readonly points: readonly PathPoint[]; readonly outcome: 'finished' | 'stopped' | 'mechanism' }
  /** A step failed after the last point (possibly the first step: then only the origin is in points). */
  | { readonly points: readonly PathPoint[]; readonly outcome: 'not_converged'; readonly failure: StepFailure };

const dot = (a: Float64Array, b: Float64Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += at(a, i) * at(b, i);
  return sum;
};

const freeOf = (model: FrameModel, global: Float64Array): Float64Array => Float64Array.from(model.free, (dof) => global[dof] ?? 0);

/** `u` with `delta` (free dofs) added. */
function plus(model: FrameModel, u: Float64Array, delta: Float64Array): Float64Array {
  const next = Float64Array.from(u);
  model.free.forEach((dof, k) => (next[dof] = at(u, dof) + at(delta, k)));
  return next;
}

/** True when the unloaded tangent cannot carry the reference load (singular, or a rigid-body mode that rounding left finite). */
function isMechanism(model: FrameModel, referenceFree: Float64Array): boolean {
  const { stiffness } = assemble(model, new Float64Array(model.dofs));
  const lu = factor(stiffness);
  if (lu === null) return true;
  const compliance = solve(lu, referenceFree);
  const ratio = (Math.sqrt(dot(compliance, compliance)) * maxDiagonal(stiffness)) / Math.sqrt(dot(referenceFree, referenceFree));
  return !(ratio <= MECHANISM_COMPLIANCE);
}

const toleranceAt = (lambda: number, referenceNorm: number): number => RESIDUAL_TOLERANCE * Math.max(1, Math.abs(lambda) * referenceNorm);

/** Free-dof residual lambda x Pref - F. */
function residual(model: FrameModel, lambda: number, reference: Float64Array, force: Float64Array): Float64Array {
  return Float64Array.from(model.free, (dof) => lambda * at(reference, dof) - at(force, dof));
}

/**
 * Spherical arc-length from the unloaded state.
 * @invariant deterministic; the first point is (0, 0); `stop` is asked after every converged step
 */
export function arcLengthPath(
  model: FrameModel,
  reference: Float64Array,
  arcLength: number,
  maxSteps: number,
  stop: (point: PathPoint) => boolean,
): PathResult {
  const referenceFree = freeOf(model, reference);
  const referenceNorm = Math.sqrt(dot(referenceFree, referenceFree));
  let u: Float64Array = new Float64Array(model.dofs);
  let lambda = 0;
  const points: PathPoint[] = [{ loadFactor: 0, u }];
  if (isMechanism(model, referenceFree)) return { points, outcome: 'mechanism' };
  let previous: Float64Array | null = null;
  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
    const start = factor(assemble(model, u).stiffness);
    if (start === null) return { points, outcome: 'not_converged', failure: 'singular_tangent' };
    let tangent = solve(start, referenceFree);
    let dLambda = arcLength / Math.sqrt(dot(tangent, tangent));
    if (previous !== null && dot(tangent, previous) < 0) dLambda = -dLambda;
    let Du = tangent.map((value) => dLambda * value);
    let DLambda = dLambda;
    let converged = false;
    let failure: StepFailure = 'iterations';
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const { force, stiffness } = assemble(model, plus(model, u, Du));
      const R = residual(model, lambda + DLambda, reference, force);
      if (Math.sqrt(dot(R, R)) < toleranceAt(lambda + DLambda, referenceNorm)) {
        converged = true;
        break;
      }
      const lu = factor(stiffness);
      if (lu === null) {
        failure = 'singular_corrector';
        break;
      }
      tangent = solve(lu, referenceFree);
      const correction = solve(lu, R);
      const shifted = Du.map((value, k) => value + (correction[k] ?? 0));
      const a = dot(tangent, tangent);
      const b = 2 * dot(tangent, shifted);
      const c = dot(shifted, shifted) - arcLength * arcLength;
      const discriminant = b * b - 4 * a * c;
      if (discriminant < 0) {
        failure = 'no_real_root';
        break;
      }
      const root1 = (-b + Math.sqrt(discriminant)) / (2 * a);
      const root2 = (-b - Math.sqrt(discriminant)) / (2 * a);
      let along1 = 0;
      let along2 = 0;
      for (let k = 0; k < Du.length; k++) {
        along1 += at(Du, k) * (at(Du, k) + at(correction, k) + root1 * at(tangent, k));
        along2 += at(Du, k) * (at(Du, k) + at(correction, k) + root2 * at(tangent, k));
      }
      const chosen = along1 >= along2 ? root1 : root2;
      const before = Du;
      Du = before.map((value, k) => value + at(correction, k) + chosen * at(tangent, k));
      DLambda += chosen;
      const delta = Du.map((value, k) => value - (before[k] ?? 0));
      if (Math.sqrt(dot(delta, delta)) <= STAGNATION * Math.sqrt(dot(Du, Du))) {
        converged = true;
        break;
      }
    }
    if (!converged) return { points, outcome: 'not_converged', failure };
    u = plus(model, u, Du);
    lambda += DLambda;
    previous = Du;
    const point = { loadFactor: lambda, u };
    points.push(point);
    if (stop(point)) return { points, outcome: 'stopped' };
  }
  return { points, outcome: 'finished' };
}

/**
 * Load control: `increments` equal load-factor steps up to `maxFactor`, Newton from the previous solution at each.
 * @invariant deterministic; the first point is (0, 0); a limit point cannot be passed (the step stops converging there)
 */
export function loadControlPath(
  model: FrameModel,
  reference: Float64Array,
  increments: number,
  maxFactor: number,
  stop: (point: PathPoint) => boolean,
): PathResult {
  const referenceFree = freeOf(model, reference);
  const referenceNorm = Math.sqrt(dot(referenceFree, referenceFree));
  let u: Float64Array = new Float64Array(model.dofs);
  const points: PathPoint[] = [{ loadFactor: 0, u }];
  if (isMechanism(model, referenceFree)) return { points, outcome: 'mechanism' };
  for (let increment = 1; increment <= increments; increment++) {
    const lambda = (maxFactor * increment) / increments;
    let converged = false;
    let failure: StepFailure = 'iterations';
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const { force, stiffness } = assemble(model, u);
      const R = residual(model, lambda, reference, force);
      if (Math.sqrt(dot(R, R)) < toleranceAt(lambda, referenceNorm)) {
        converged = true;
        break;
      }
      const lu = factor(stiffness);
      if (lu === null) {
        failure = 'singular_tangent';
        break;
      }
      const delta = solve(lu, R);
      u = plus(model, u, delta);
      const size = freeOf(model, u);
      if (Math.sqrt(dot(delta, delta)) <= STAGNATION * Math.sqrt(dot(size, size))) {
        converged = true;
        break;
      }
    }
    if (!converged) return { points, outcome: 'not_converged', failure };
    const point = { loadFactor: lambda, u };
    points.push(point);
    if (stop(point)) return { points, outcome: 'stopped' };
  }
  return { points, outcome: 'finished' };
}
