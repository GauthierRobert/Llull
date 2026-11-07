/**
 * Two-node thermal network of a datasheet DC motor (PHY-23 TR-DRV-09): winding (C_w = tau_w / R_th1) coupled by R_th1 to the housing
 * (C_s = tau_s / R_th2), the housing coupled to the ambient by R_th2. The copper resistance follows R(T) = R25 (1 + alpha (T_w - 25 C)).
 * The step is the exact matrix exponential of the 2x2 network for a constant power over the step; the winding power is evaluated at the
 * start-of-step temperature (alpha enters through the step's resistance, not inside the exponential).
 */

import type { DcMotorDatasheet, ThermalSheet } from '@core/model/drives';
import { elementAt } from '@lib/elementAt';

/** Default copper temperature coefficient, 1/K (maxon catalogue convention, D-DRV-05). */
const DEFAULT_ALPHA_PER_K = 0.0039;
/** Reference temperature of the datasheet resistance, C. */
const REFERENCE_C = 25;

export interface ThermalParams {
  readonly rWindingHousing: number;
  readonly rHousingAmbient: number;
  readonly cWinding: number;
  readonly cHousing: number;
  /** Terminal resistance at 25 C, ohm. */
  readonly r25: number;
  readonly alpha: number;
  readonly maxWindingC: number;
  /** Datasheet time constants, s (winding, motor): reported against the network's own eigen time constants. */
  readonly datasheetTaus: readonly [number, number];
}

/** Rises above the ambient, K: [winding, housing]. */
type ThermalState = readonly [number, number];

/** The network of a DC datasheet, or null when it carries no thermal data. */
export const thermalParams = (sheet: DcMotorDatasheet): ThermalParams | null => thermalNetwork(sheet.thermal, sheet.terminalResistanceOhm);

/**
 * The network of a thermal block, or null when there is none. `r25` is the effective copper resistance, ohm: copper power = r25 · current² with the
 * current the motor kind records (dc R; pmsm 1.5·R at the phase amplitude; stepper 2·R per phase current; induction 3·(R1 + R2) at the load current I2).
 */
export function thermalNetwork(thermal: ThermalSheet | undefined, r25: number): ThermalParams | null {
  if (thermal === undefined) return null;
  return {
    rWindingHousing: thermal.rthWindingHousingKPerW,
    rHousingAmbient: thermal.rthHousingAmbientKPerW,
    cWinding: thermal.tauWindingS / thermal.rthWindingHousingKPerW,
    cHousing: thermal.tauMotorS / thermal.rthHousingAmbientKPerW,
    r25,
    alpha: thermal.alphaPerK === undefined ? DEFAULT_ALPHA_PER_K : thermal.alphaPerK,
    maxWindingC: thermal.maxWindingC,
    datasheetTaus: [thermal.tauWindingS, thermal.tauMotorS],
  };
}

/** The 2x2 system matrix A (1/s) of d[T_w, T_s]/dt = A [T_w, T_s] + [1/C_w, 0] P, row-major. */
function systemMatrix(p: ThermalParams): readonly [number, number, number, number] {
  const [a, b] = [1 / (p.rWindingHousing * p.cWinding), 1 / (p.rWindingHousing * p.cHousing)];
  return [-a, a, b, -(b + 1 / (p.rHousingAmbient * p.cHousing))];
}

/** Eigenvalues of A (negative and real for a passive RC network). */
function eigenvalues(p: ThermalParams): readonly [number, number] {
  const [a11, a12, a21, a22] = systemMatrix(p);
  const root = Math.sqrt(Math.max(0, (a11 - a22) ** 2 / 4 + a12 * a21));
  return [(a11 + a22) / 2 + root, (a11 + a22) / 2 - root];
}

/** Time constants (s) of the coupled network: [slow, fast]. */
export function networkTimeConstants(p: ThermalParams): readonly [slow: number, fast: number] {
  const [first, second] = eigenvalues(p);
  return [-1 / first, -1 / second];
}

/** Exact state after `h` seconds with a constant winding power `powerW`. */
function stepThermal(p: ThermalParams, state: ThermalState, powerW: number, h: number): ThermalState {
  const [a11, a12, a21, a22] = systemMatrix(p);
  const [l1, l2] = eigenvalues(p);
  const [e1, e2] = [Math.exp(l1 * h), Math.exp(l2 * h)];
  // e^{Ah} = c1 A + c0 I (Cayley-Hamilton, distinct eigenvalues)
  const [c1, c0] = [(e1 - e2) / (l1 - l2), (l1 * e2 - l2 * e1) / (l1 - l2)];
  const exp = [c1 * a11 + c0, c1 * a12, c1 * a21, c1 * a22 + c0] as const;
  // x(h) = e^{Ah} (x0 - x_ss) + x_ss with x_ss = -A^-1 B P
  const det = a11 * a22 - a12 * a21;
  const input = powerW / p.cWinding;
  const steady = [(-a22 * input) / det, (a21 * input) / det] as const;
  const [d0, d1] = [state[0] - steady[0], state[1] - steady[1]];
  return [exp[0] * d0 + exp[1] * d1 + steady[0], exp[2] * d0 + exp[3] * d1 + steady[1]];
}

/** Copper resistance at a winding temperature (C), ohm. */
const resistanceAt = (p: ThermalParams, windingC: number): number => p.r25 * (1 + p.alpha * (windingC - REFERENCE_C));

/** Winding and housing temperatures (C) along a current series: from the ambient, one exact step per sample interval at the interval's mean i^2. */
export function windingTemperatureSeries(
  p: ThermalParams,
  times: readonly number[],
  currentA: readonly number[],
  ambientC: number,
): { readonly windingC: number[]; readonly housingC: number[] } {
  let state: ThermalState = [0, 0];
  const windingC = [ambientC];
  const housingC = [ambientC];
  for (let k = 1; k < times.length; k++) {
    const h = elementAt(times, k) - elementAt(times, k - 1);
    const [i0, i1] = [elementAt(currentA, k - 1), elementAt(currentA, k)];
    const power = ((i0 * i0 + i1 * i1) / 2) * resistanceAt(p, ambientC + state[0]);
    if (h > 0) state = stepThermal(p, state, power, h);
    windingC.push(ambientC + state[0]);
    housingC.push(ambientC + state[1]);
  }
  return { windingC, housingC };
}

/** k = R_th (total) I^2 R25: the dimensionless self-heating of a sustained current. */
const selfHeating = (p: ThermalParams, currentA: number): number => (p.rWindingHousing + p.rHousingAmbient) * currentA * currentA * p.r25;

/** Sustained RMS current at which the copper loss feeds itself faster than the network removes it (k alpha = 1). */
export const runawayCurrent = (p: ThermalParams): number => Math.sqrt(1 / (p.alpha * (p.rWindingHousing + p.rHousingAmbient) * p.r25));

/** Steady winding temperature (C) at a sustained RMS current, or null at or above the runaway current (no steady state). */
export function steadyWindingC(p: ThermalParams, rmsCurrentA: number, ambientC: number): number | null {
  const k = selfHeating(p, rmsCurrentA);
  if (k * p.alpha >= 1) return null;
  return (ambientC + k * (1 - REFERENCE_C * p.alpha)) / (1 - k * p.alpha);
}

/** Largest sustained current (A) that keeps the winding at its maximum temperature. */
export function continuousCurrentAtLimit(p: ThermalParams, ambientC: number): number {
  const k = (p.maxWindingC - ambientC) / (1 - REFERENCE_C * p.alpha + p.alpha * p.maxWindingC);
  return Math.sqrt(Math.max(0, k) / ((p.rWindingHousing + p.rHousingAmbient) * p.r25));
}

/** Winding temperature rise (K) after `seconds` of a constant power with alpha = 0 (the closed-form network response, for checks). */
export function windingRiseAt(p: ThermalParams, powerW: number, seconds: number): number {
  return stepThermal(p, [0, 0], powerW, seconds)[0];
}
