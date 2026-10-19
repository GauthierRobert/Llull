/**
 * Brake calibration of the single-zone heat release (FR-FPR-72 / 78, TR-FPR-16): at each named point the heat per cycle Q is found by secant
 * iteration so that the BRAKE mean effective pressure, IMEP(Q) - FMEP(rpm, p_max(Q)), meets the target (the friction depends on the peak
 * pressure, so the problem is not linear in Q). Tolerance 0.1 % of the target, at most 30 iterations, else FPR_CALIBRATION_FAILED.
 */

import type { CylinderPressure, EngineLosses } from '../../model/dynamics';
import type { CurveCode, CylinderGeometry } from '../pressureCurve';
import { singleZoneCurve } from '../singleZone';
import { fmepAt } from './engineLosses';

/** Relative tolerance on the brake target and iteration cap (named, TECHNICAL_SPEC 5.9). */
const CALIBRATION_TOLERANCE = 1e-3;
const MAX_ITERATIONS = 30;
/** Brake thermal share assumed for the first guess of Q only (does not affect the result). */
const GUESS_EFFICIENCY = 0.3;

type SingleZone = Extract<CylinderPressure['model'], { kind: 'single_zone' }>;

export interface BrakePoint {
  readonly rpm: number;
  /** Mean BRAKE torque of the whole engine, N·m. */
  readonly brakeTorqueNm: number;
}

export interface CalibratedPoint {
  readonly rpm: number;
  /** Heat released per cycle per cylinder, J. */
  readonly heatJ: number;
  readonly iterations: number;
  readonly imepPa: number;
  readonly fmepPa: number;
  readonly bmepPa: number;
  readonly peakPa: number;
}

export interface CalibrationFailure {
  readonly code: CurveCode | 'FPR_CALIBRATION_FAILED';
  readonly error: string;
}

interface Trial {
  readonly f: number;
  readonly point: CalibratedPoint;
}

/** Heat per cycle per cylinder that makes the cylinder's share (`brakeTorqueNm / cylinderCount`) of the brake torque at `point.rpm`. */
export function calibrateBrakePoint(
  cylinder: CylinderPressure & { model: SingleZone },
  geometry: CylinderGeometry,
  losses: EngineLosses,
  point: BrakePoint,
  cylinderCount: number,
): CalibratedPoint | CalibrationFailure {
  const cycleRad = cylinder.cycle === 'four_stroke' ? 4 * Math.PI : 2 * Math.PI;
  const targetBmep = (cycleRad * point.brakeTorqueNm) / cylinderCount / geometry.displacementM3;
  const evaluate = (heatJ: number): Trial | CalibrationFailure => {
    const trial: SingleZone = { ...cylinder.model, heat: { kind: 'per_cycle_J', value: heatJ } };
    const curve = singleZoneCurve(cylinder, geometry, trial, point.rpm);
    if ('error' in curve) return curve;
    const fmepPa = fmepAt(losses, point.rpm, curve.peakPa).pa;
    const bmepPa = curve.imepPa - fmepPa;
    return {
      f: bmepPa - targetBmep,
      point: { rpm: point.rpm, heatJ, iterations: 0, imepPa: curve.imepPa, fmepPa, bmepPa, peakPa: curve.peakPa },
    };
  };
  const guess = ((targetBmep + fmepAt(losses, point.rpm, 5e6).pa) * geometry.displacementM3) / GUESS_EFFICIENCY;
  let [q0, q1] = [guess, guess * 1.1];
  const start = evaluate(q0);
  if ('error' in start) return start;
  const next = evaluate(q1);
  if ('error' in next) return next;
  const within = (trial: Trial): boolean => Math.abs(trial.f) <= CALIBRATION_TOLERANCE * targetBmep;
  for (const trial of [start, next]) if (within(trial)) return { ...trial.point, iterations: 1 };
  let [first, second]: [Trial, Trial] = [start, next];
  let best: Trial = Math.abs(start.f) < Math.abs(next.f) ? start : next;
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const slope = (second.f - first.f) / (q1 - q0);
    if (!(Math.abs(slope) > 0) || !Number.isFinite(slope)) break;
    const proposed: number = q1 - second.f / slope;
    const heat = proposed > 0 ? proposed : q1 / 2;
    const evaluated = evaluate(heat);
    if ('error' in evaluated) return evaluated;
    // every trial is checked as soon as it is evaluated, the last one included
    if (within(evaluated)) return { ...evaluated.point, iterations: iteration + 1 };
    if (Math.abs(evaluated.f) < Math.abs(best.f)) best = evaluated;
    [q0, q1, first, second] = [q1, heat, second, evaluated];
  }
  return {
    code: 'FPR_CALIBRATION_FAILED',
    error:
      `brake target ${point.brakeTorqueNm} N·m at ${point.rpm} rpm not reached: best ${(((best.point.bmepPa * geometry.displacementM3) / cycleRad) * cylinderCount).toFixed(3)} N·m ` +
      `after ${MAX_ITERATIONS} iterations (heat ${best.point.heatJ.toPrecision(5)} J per cycle)`,
  };
}
