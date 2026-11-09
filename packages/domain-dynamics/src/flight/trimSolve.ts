/**
 * Trim of a flight vehicle (13 FLT M5): the steady, straight, wings-level-or-not flight at an airspeed and flight-path angle in which the force and
 * moment of the run's own laws balance. Unknowns: roll and pitch (and the flight-path angle when it is free), plus every control (controlled rotor
 * speeds, servo pivot angles) inside its limits. Damped Gauss-Newton (Levenberg-Marquardt) on the six body accelerations with central-difference
 * Jacobians; when the controls outnumber the six equations the damping selects the minimum-norm step (controls scaled by their range), so a symmetric
 * vehicle keeps its symmetric solution. Deterministic: fixed starts, fixed steps.
 */

import { elementAt } from '@lib/elementAt';
import { solveDense } from '@lib/denseLinalg';
import { rotateInverse } from './frames';
import { orientationOf, stateDerivative, type TrimVehicle } from './trimModel';

export interface TrimCondition {
  /** Speed relative to the air along the flight path, m/s. */
  readonly airspeedMps: number;
  /** Flight-path angle (climb positive), deg; ignored when `freeFlightPath`. */
  readonly flightPathDeg: number;
  /** Solve the flight-path angle too (a glide or climb the controls cannot hold level). */
  readonly freeFlightPath: boolean;
}

export interface TrimState {
  readonly roll: number;
  readonly pitch: number;
  /** Flight-path angle, rad. */
  readonly flightPath: number;
  /** Control values in `vehicle.controls` order (rpm / deg). */
  readonly controls: readonly number[];
}

export type TrimResult =
  | { readonly ok: true; readonly state: TrimState; readonly iterations: number; readonly residual: number }
  | {
      readonly ok: false;
      readonly code: 'FLT_TRIM_NOT_CONVERGED' | 'FLT_TRIM_SATURATED';
      readonly message: string;
      readonly residual: number;
    };

/** Residual (body accelerations over the reference acceleration, dimensionless) below which the vehicle counts as trimmed. */
export const TRIM_TOLERANCE = 1e-9;
const MAX_ITERATIONS = 80;
const JACOBIAN_STEP = 1e-6;
const ANGLE_LIMIT = (80 * Math.PI) / 180;
/** Pitch starts tried in order (rad): level first, then nose up and down (the wing needs an angle of attack the first start may miss). */
const PITCH_STARTS = [0, 0.05, -0.05, 0.14, -0.14, 0.3];

/** Body velocity of a steady flight at `airspeed` along path angle `flightPath` with the attitude (heading 0). */
export function bodyVelocity(airspeed: number, flightPath: number, roll: number, pitch: number): [number, number, number] {
  const [u, v, w] = rotateInverse(orientationOf(roll, pitch), [airspeed * Math.cos(flightPath), 0, airspeed * Math.sin(flightPath)]);
  return [u, v, w];
}

const norm = (values: readonly number[]): number => Math.hypot(...values);
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Reference acceleration (m/s²) and angular acceleration (rad/s²) the residual is divided by. */
function scales(vehicle: TrimVehicle): { linear: number; angular: number } {
  const g = Math.max(Math.hypot(...vehicle.gravity), 1);
  const radius = Math.sqrt(Math.max(vehicle.inertia[0][0] + vehicle.inertia[1][1] + vehicle.inertia[2][2], 1e-12) / (2 * vehicle.massKg));
  return { linear: g, angular: g / Math.max(radius, 1e-3) };
}

/** The six body accelerations (u, v, w, p, q, r dots) at the trim state, in SI. */
export function trimAccelerations(vehicle: TrimVehicle, condition: TrimCondition, state: TrimState): number[] {
  const velocity = bodyVelocity(condition.airspeedMps, state.flightPath, state.roll, state.pitch);
  return stateDerivative(vehicle, [...velocity, 0, 0, 0, state.roll, state.pitch], state.controls).slice(0, 6);
}

/** Unknown vector z <-> state: [roll, pitch, (flight path), controls scaled to 0..1 of their range]. */
function pack(vehicle: TrimVehicle, free: boolean, state: TrimState): number[] {
  return [
    state.roll,
    state.pitch,
    ...(free ? [state.flightPath] : []),
    ...vehicle.controls.map((control, i) => ((state.controls[i] ?? control.initial) - control.min) / (control.max - control.min)),
  ];
}

function unpack(vehicle: TrimVehicle, condition: TrimCondition, z: readonly number[]): TrimState {
  const free = condition.freeFlightPath;
  const offset = free ? 3 : 2;
  return {
    roll: z[0] ?? 0,
    pitch: z[1] ?? 0,
    flightPath: free ? (z[2] ?? 0) : (condition.flightPathDeg * Math.PI) / 180,
    controls: vehicle.controls.map((control, i) => control.min + (z[offset + i] ?? 0) * (control.max - control.min)),
  };
}

function bounds(vehicle: TrimVehicle, free: boolean): { low: number[]; high: number[] } {
  const angles = free ? [-ANGLE_LIMIT, -ANGLE_LIMIT, -ANGLE_LIMIT] : [-ANGLE_LIMIT, -ANGLE_LIMIT];
  return { low: [...angles, ...vehicle.controls.map(() => 0)], high: [...angles.map((value) => -value), ...vehicle.controls.map(() => 1)] };
}

/** Levenberg-Marquardt step for J dz = -r: dual form (minimum norm) when there are at least as many unknowns as equations. */
function step(jacobian: readonly (readonly number[])[], residual: readonly number[], damping: number): number[] | null {
  const m = residual.length;
  const n = jacobian.reduce((most, row) => Math.max(most, row.length), 0);
  const at = (i: number, j: number): number => jacobian[i]?.[j] ?? 0;
  if (n >= m) {
    const gram = Array.from({ length: m }, (_, i) =>
      Array.from({ length: m }, (_, j) => {
        let sum = 0;
        for (let k = 0; k < n; k += 1) sum += at(i, k) * at(j, k);
        return sum + (i === j ? damping : 0);
      }),
    );
    const y = solveDense(
      gram,
      residual.map((value) => -value),
      0,
    );
    return y === null ? null : Array.from({ length: n }, (_, k) => y.reduce((sum, value, i) => sum + value * at(i, k), 0));
  }
  const normal = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      let sum = 0;
      for (let k = 0; k < m; k += 1) sum += at(k, i) * at(k, j);
      return sum + (i === j ? damping : 0);
    }),
  );
  return solveDense(
    normal,
    Array.from({ length: n }, (_, j) => {
      let sum = 0;
      for (let k = 0; k < m; k += 1) sum -= at(k, j) * (residual[k] ?? 0);
      return sum;
    }),
    0,
  );
}

function solveFrom(vehicle: TrimVehicle, condition: TrimCondition, start: TrimState): TrimResult {
  const free = condition.freeFlightPath;
  const scale = scales(vehicle);
  const weights = [scale.linear, scale.linear, scale.linear, scale.angular, scale.angular, scale.angular];
  const residualOf = (z: readonly number[]): number[] =>
    trimAccelerations(vehicle, condition, unpack(vehicle, condition, z)).map((value, i) => value / elementAt(weights, i));
  const { low, high } = bounds(vehicle, free);
  let z = pack(vehicle, free, start).map((value, i) => clamp(value, elementAt(low, i), elementAt(high, i)));
  let r = residualOf(z);
  let damping = 1e-3;
  let iterations = 0;
  while (iterations < MAX_ITERATIONS && Math.max(...r.map(Math.abs)) > TRIM_TOLERANCE) {
    iterations += 1;
    const columns = z.map((_, k) => {
      const up = z.map((value, i) => (i === k ? value + JACOBIAN_STEP : value));
      const down = z.map((value, i) => (i === k ? value - JACOBIAN_STEP : value));
      const hi = residualOf(up);
      const lo = residualOf(down);
      return hi.map((value, i) => (value - (lo[i] ?? 0)) / (2 * JACOBIAN_STEP));
    });
    const jacobian = r.map((_, i) => columns.map((column) => column[i] ?? 0));
    let accepted = false;
    for (let attempt = 0; attempt < 12 && !accepted; attempt += 1) {
      const trial = step(jacobian, r, damping);
      if (trial === null) {
        damping *= 10;
        continue;
      }
      const next = z.map((value, i) => clamp(value + elementAt(trial, i), elementAt(low, i), elementAt(high, i)));
      const nextResidual = residualOf(next);
      if (norm(nextResidual) < norm(r)) {
        z = next;
        r = nextResidual;
        damping = Math.max(damping / 5, 1e-12);
        accepted = true;
      } else damping *= 5;
    }
    if (!accepted) break;
  }
  const residual = Math.max(...r.map(Math.abs));
  if (residual <= TRIM_TOLERANCE) return { ok: true, state: unpack(vehicle, condition, z), iterations, residual };
  const offset = free ? 3 : 2;
  const stuck = vehicle.controls.filter((_, i) => {
    const value = z[offset + i] ?? 0.5;
    return value <= 1e-9 || value >= 1 - 1e-9;
  });
  return stuck.length > 0
    ? {
        ok: false,
        code: 'FLT_TRIM_SATURATED',
        message: `no balance inside the control limits: ${stuck.map((control) => `'${control.id}'`).join(', ')} at its limit, residual ${residual.toExponential(2)} of the reference acceleration`,
        residual,
      }
    : {
        ok: false,
        code: 'FLT_TRIM_NOT_CONVERGED',
        message: `the Gauss-Newton iteration stopped after ${iterations} iterations at residual ${residual.toExponential(2)} of the reference acceleration (tolerance ${TRIM_TOLERANCE})`,
        residual,
      };
}

/** Trim `vehicle` at `condition`: the first start (level, then nose up / down) that converges, else the failure of the closest one. */
export function solveTrim(vehicle: TrimVehicle, condition: TrimCondition): TrimResult {
  let best: TrimResult | null = null;
  for (const pitch of PITCH_STARTS) {
    const result = solveFrom(vehicle, condition, {
      roll: 0,
      pitch,
      flightPath: (condition.flightPathDeg * Math.PI) / 180,
      controls: vehicle.controls.map((control) => control.initial),
    });
    if (result.ok) return result;
    if (best === null || (!best.ok && result.residual < best.residual)) best = result;
  }
  return best as TrimResult;
}
