/**
 * Longitudinal rate damping of a lumped aero table by the tail-arm estimate (13 FLT M5b). A table generated with a pivoting (all-moving) tail
 * carries that tail's lift slope and arm in its pivot derivatives: CL_δ = η a_t S_t / S and Cm_δ = −CL_δ l_t / c̄, so l_t = −c̄ Cm_δ / CL_δ.
 * A pitch rate q (nose up) and a rate of change of incidence α̇ change the tail angle of attack by (l_t / V)(q + dε/dα α̇) (Nelson, Flight
 * Stability and Automatic Control, 2nd ed., ch. 3, the tail pitch-rate and α̇ derivatives: C_mq = −2 η a_t V_H l_t / c̄, C_Lq = 2 η a_t V_H,
 * C_mα̇ = C_mq dε/dα; Etkin & Reid, Dynamics of Flight, 3rd ed., ch. 5, the same tail-arm estimate), applied as a tail lift Q S CL_δ Δα_t at the tail. The downwash slope is the elliptic-wing estimate
 * dε/dα = 2 CL_αw / (π A) with A = b² / S of the table reference (the wing by default) and the wing lift slope CL_αw backed out of the table's CL_α.
 * Validity: a pivoting tail (an elevator flap gives τ CL_δ), attached flow (α inside the table's valid range), quasi-steady (reduced frequency
 * ω c̄ / 2V well below 1), the wing's and fuselage's own rate terms neglected (Nelson adds about 10 % to the tail C_mq for them; not done here).
 */

import type { Vec3 } from '@core/model/vectors';
import { elementAt } from '@lib/elementAt';
import { add3, cross3, dot3, scale3, vec3At } from '@lib/vec3';
import type { AeroRuntime } from './aeroSurface';
import { lookupAero } from './aeroTable';
import { stateDerivative, type TrimVehicle } from './trimModel';

const RAD = Math.PI / 180;
/** Half-width of the table slope differences, deg (the table is piecewise linear: any width inside a cell gives its slope). */
const SLOPE_STEP_DEG = 0.5;
/** |CL_δ| below which the pivot moves no lifting surface (no tail to estimate from), per rad. */
const MIN_PIVOT_SLOPE = 1e-6;
/** Upper bound of the downwash slope (the estimate exceeds 1 only for a very low aspect ratio, where it does not hold). */
const MAX_DOWNWASH_SLOPE = 0.9;

/** The rate-damping estimate of one pivoting surface at the trim. */
export interface RateDampingTerm {
  readonly surfaceId: string;
  /** Index of the surface in `vehicle.aero`. */
  readonly index: number;
  /** Tail arm behind the table's moment centre, m (−c̄ Cm_δ / CL_δ; negative for a canard). */
  readonly tailArmM: number;
  /** CL_δ = η a_t S_t / S, per rad. */
  readonly tailLiftSlopePerRad: number;
  /** CL_α of the table at the trim, per rad. */
  readonly liftSlopePerRad: number;
  /** dε/dα at the tail (0 for a surface ahead of the moment centre). */
  readonly downwashSlope: number;
  /** Non-dimensional derivatives on the table reference (q̂ = q c̄ / 2V, α̂̇ = α̇ c̄ / 2V). */
  readonly cmq: number;
  readonly clq: number;
  readonly cmAlphaDot: number;
}

/** Slope of `f` at `x` by a difference kept inside [lo, hi]. */
function slope(f: (x: number) => number, x: number, lo: number, hi: number): number {
  const below = Math.max(lo, x - SLOPE_STEP_DEG);
  const above = Math.min(hi, x + SLOPE_STEP_DEG);
  return above > below ? (f(above) - f(below)) / ((above - below) * RAD) : 0;
}

/** The term of `runtime` at the trim angle of attack and pivot, deg; null without a pivot servo or when the pivot carries no lift. */
function termOf(runtime: AeroRuntime, index: number, alphaDeg: number, pivotDeg: number): RateDampingTerm | null {
  const { surface } = runtime;
  const { table } = surface;
  if (surface.servo === null || table.pivotDeg.length < 2) return null;
  const pivots = [elementAt(table.pivotDeg, 0), elementAt(table.pivotDeg, table.pivotDeg.length - 1)] as const;
  const alphas = [elementAt(table.alphaDeg, 0), elementAt(table.alphaDeg, table.alphaDeg.length - 1)] as const;
  const clDelta = slope((deg) => lookupAero(table, alphaDeg, deg).cl, pivotDeg, ...pivots);
  if (!(Math.abs(clDelta) > MIN_PIVOT_SLOPE)) return null;
  const cmDelta = slope((deg) => lookupAero(table, alphaDeg, deg).cm, pivotDeg, ...pivots);
  const clAlpha = slope((deg) => lookupAero(table, deg, pivotDeg).cl, alphaDeg, ...alphas);
  const chord = surface.refChordM;
  const arm = (-chord * cmDelta) / clDelta;
  const aspect = (surface.refSpanM * surface.refSpanM) / surface.refAreaM2;
  // CL_α = CL_αw + CL_δ (1 − dε/dα) with dε/dα = 2 CL_αw / (π A): solved for the wing's own slope
  const denominator = 1 - (2 * clDelta) / (Math.PI * aspect);
  const wing = denominator > 0 ? (clAlpha - clDelta) / denominator : 0;
  const downwash = arm > 0 ? Math.min(MAX_DOWNWASH_SLOPE, Math.max(0, (2 * wing) / (Math.PI * aspect))) : 0;
  const cmq = -2 * clDelta * (arm / chord) * (arm / chord);
  return {
    surfaceId: surface.id,
    index,
    tailArmM: arm,
    tailLiftSlopePerRad: clDelta,
    liftSlopePerRad: clAlpha,
    downwashSlope: downwash,
    cmq,
    clq: 2 * clDelta * (arm / chord),
    cmAlphaDot: cmq * downwash,
  };
}

/** The terms of every pivoting surface of `vehicle` at the trim angles of attack `alphasDeg` and pivots `pivotsDeg` (per surface). */
export function rateDampingTerms(vehicle: TrimVehicle, alphasDeg: readonly number[], pivotsDeg: readonly number[]): RateDampingTerm[] {
  return vehicle.aero.flatMap((runtime, i) => {
    const term = termOf(runtime, i, elementAt(alphasDeg, i), elementAt(pivotsDeg, i));
    return term === null ? [] : [term];
  });
}

/**
 * x-dot of `stateDerivative` plus the tail lift of the rate terms: ΔL = Q S CL_δ (l_t / V)(q_nose + dε/dα α̇) along the lift direction at the tail
 * (the moment centre moved l_t downstream), with α̇ from the translational acceleration of the other forces (Z_α̇ does not feed back into α̇).
 * Zero at a trim (no rates, no α̇), so it changes the linearisation, never the trim.
 */
export function dampedDerivative(
  vehicle: TrimVehicle,
  terms: readonly RateDampingTerm[],
  x: readonly number[],
  values: readonly number[],
): number[] {
  const base = stateDerivative(vehicle, x, values);
  if (terms.length === 0) return base;
  const velocity = vec3At(x, 0);
  const rates = vec3At(x, 3);
  const acceleration = vec3At(base, 0);
  let force: Vec3 = [0, 0, 0];
  let moment: Vec3 = [0, 0, 0];
  for (const term of terms) {
    const runtime = elementAt(vehicle.aero, term.index);
    const { frame, surface } = runtime;
    const air = scale3(add3(velocity, cross3(rates, runtime.arm)), -1);
    const ux = dot3(air, frame.x);
    const uz = dot3(air, frame.z);
    const speedSquared = ux * ux + uz * uz;
    if (!(ux > 0) || speedSquared < 1e-12) continue;
    const speed = Math.sqrt(speedSquared);
    const alpha = Math.atan2(uz, ux);
    const alphaDot = (ux * dot3(scale3(acceleration, -1), frame.z) - uz * dot3(scale3(acceleration, -1), frame.x)) / speedSquared;
    const pitchRate = dot3(rates, frame.y);
    const tailAlpha = (term.tailArmM / speed) * (pitchRate + term.downwashSlope * alphaDot);
    const lift = 0.5 * surface.airDensity * speedSquared * surface.refAreaM2 * term.tailLiftSlopePerRad * tailAlpha;
    const along = add3(scale3(frame.x, -Math.sin(alpha) * lift), scale3(frame.z, Math.cos(alpha) * lift));
    force = add3(force, along);
    moment = add3(moment, cross3(add3(runtime.arm, scale3(frame.x, term.tailArmM)), along));
  }
  const linear = scale3(force, 1 / vehicle.massKg);
  const i = vehicle.inertiaInverse;
  const angular: Vec3 = [
    i[0][0] * moment[0] + i[0][1] * moment[1] + i[0][2] * moment[2],
    i[1][0] * moment[0] + i[1][1] * moment[1] + i[1][2] * moment[2],
    i[2][0] * moment[0] + i[2][1] * moment[1] + i[2][2] * moment[2],
  ];
  return base.map((value, k) => value + (k < 3 ? elementAt(linear, k) : k < 6 ? elementAt(angular, k - 3) : 0));
}
