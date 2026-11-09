/** Linearisation of a flight vehicle about a trim (13 FLT M5): central-difference Jacobians of the state derivative of trimModel.ts. */

import { elementAt } from '@lib/elementAt';
import { stateDerivative, type TrimVehicle } from './trimModel';

/** Central-difference step per state (m/s, m/s, m/s, rad/s x3, rad x2): small against the scales, large against the round-off of the laws. */
const STATE_STEPS = [1e-3, 1e-3, 1e-3, 1e-4, 1e-4, 1e-4, 1e-5, 1e-5];
/** Central-difference step of a control, as a share of its range. */
const CONTROL_STEP = 1e-4;

/** J[i][j] = d f_i / d x_j by central differences with step `steps[j]`; `f` maps the vector to the outputs. */
export function centralJacobian(
  f: (x: readonly number[]) => readonly number[],
  x: readonly number[],
  steps: readonly number[],
): number[][] {
  const columns = x.map((_, j) => {
    const h = elementAt(steps, j);
    const up = f(x.map((value, k) => (k === j ? value + h : value)));
    const down = f(x.map((value, k) => (k === j ? value - h : value)));
    return up.map((value, i) => (value - (down[i] ?? 0)) / (2 * h));
  });
  const rows = columns.reduce((most, column) => Math.max(most, column.length), 0);
  return Array.from({ length: rows }, (_, i) => columns.map((column) => column[i] ?? 0));
}

export interface LinearModel {
  /** d x-dot / d x (8 x 8): states u, v, w, p, q, r, roll, pitch. */
  readonly a: number[][];
  /** d x-dot / d control (8 x controls): per rpm or per degree. */
  readonly b: number[][];
}

/** A and B of `vehicle` about the state `x0` with the controls `u0`. */
export function linearize(vehicle: TrimVehicle, x0: readonly number[], u0: readonly number[]): LinearModel {
  const a = centralJacobian((x) => stateDerivative(vehicle, x, u0), x0, STATE_STEPS);
  const b =
    vehicle.controls.length === 0
      ? x0.map(() => [])
      : centralJacobian(
          (u) => stateDerivative(vehicle, x0, u),
          u0,
          vehicle.controls.map((control) => CONTROL_STEP * (control.max - control.min)),
        );
  return { a, b };
}
