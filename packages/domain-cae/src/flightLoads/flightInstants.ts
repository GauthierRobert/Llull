/** Rigid-body instants of a flight run (14 FLL): body-frame acceleration, angular velocity / acceleration and rotor thrusts read from run_flight's series. */

import type { Vec3 } from '@core/model/vectors';
import { isRecord } from '@lib/isRecord';

const RAD = Math.PI / 180;

/** One sampled instant of a run, SI, in the body axes of the start attitude (the document axes when the vehicle starts upright and aligned). */
export interface FlightInstant {
  readonly index: number;
  readonly timeS: number;
  /** Absolute acceleration of the centre of mass, m/s^2. */
  readonly accelMps2: Vec3;
  /** Gravity acceleration field, m/s^2 (the world gravity of the dynamics model in body axes). */
  readonly gravityMps2: Vec3;
  readonly angularVelocity: Vec3;
  readonly angularAccel: Vec3;
  readonly thrustN: Readonly<Record<string, number>>;
}

const isVec3 = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every((c) => Number.isFinite(c));
const isVecList = (value: unknown, length: number): value is Vec3[] =>
  Array.isArray(value) && value.length === length && value.every(isVec3);

/** Body-axes components of a world vector for the attitude (roll, pitch, yaw in degrees, Z-Y-X): R^T v with R = Rz(yaw) Ry(pitch) Rx(roll). */
function toBodyAxes(v: Vec3, rollDeg: number, pitchDeg: number, yawDeg: number): Vec3 {
  const [cr, sr, cp, sp, cy, sy] = [
    Math.cos(rollDeg * RAD),
    Math.sin(rollDeg * RAD),
    Math.cos(pitchDeg * RAD),
    Math.sin(pitchDeg * RAD),
    Math.cos(yawDeg * RAD),
    Math.sin(yawDeg * RAD),
  ];
  const columns: readonly Vec3[] = [
    [cy * cp, sy * cp, -sp],
    [cy * sp * sr - sy * cr, sy * sp * sr + cy * cr, cp * sr],
    [cy * sp * cr + sy * sr, sy * sp * cr - cy * sr, cp * cr],
  ];
  return columns.map((column) => column[0] * v[0] + column[1] * v[1] + column[2] * v[2]) as unknown as Vec3;
}

/** d(values)/dt by central differences (one-sided at the two ends) on a non-uniform time grid. */
function derivative(times: readonly number[], values: readonly Vec3[]): Vec3[] {
  return values.map((_, k) => {
    const [a, b] = [Math.max(0, k - 1), Math.min(values.length - 1, k + 1)];
    const dt = (times[b] ?? 0) - (times[a] ?? 0);
    const [va, vb] = [values[a] ?? [0, 0, 0], values[b] ?? [0, 0, 0]];
    return [(vb[0] - va[0]) / dt, (vb[1] - va[1]) / dt, (vb[2] - va[2]) / dt] as Vec3;
  });
}

/**
 * The instants of a run_flight `detail: "series"` payload: a_world = d(velocity)/dt, alpha = d(body rate)/dt (central differences on the
 * recorded samples), everything rotated into the body axes of each sample; thrust per rotor id.
 * @failure a malformed or too short series (< 3 samples, non-increasing time, wrong lengths) -> a message string
 */
export function flightInstants(series: unknown, gravityWorld: Vec3): FlightInstant[] | string {
  if (!isRecord(series)) return 'run_flight returned no series';
  const { times, velocityMps, attitudeDeg, bodyRateDegS, rotors } = series;
  if (!Array.isArray(times) || times.length < 3 || !times.every((t) => Number.isFinite(t))) return 'the series has fewer than 3 samples';
  const n = times.length;
  if (times.some((t, k) => k > 0 && !(t > times[k - 1]))) return 'the series time is not increasing';
  if (!isVecList(velocityMps, n) || !isVecList(attitudeDeg, n) || !isVecList(bodyRateDegS, n))
    return 'the series lacks velocity, attitude or body rate';
  const world = derivative(times, velocityMps);
  const rate = bodyRateDegS.map((w): Vec3 => [w[0] * RAD, w[1] * RAD, w[2] * RAD]);
  const alpha = derivative(times, rate);
  const thrust = isRecord(rotors) ? rotors : {};
  return times.map((timeS, index): FlightInstant => {
    const [roll, pitch, yaw] = attitudeDeg[index] ?? [0, 0, 0];
    return {
      index,
      timeS,
      accelMps2: toBodyAxes(world[index] ?? [0, 0, 0], roll, pitch, yaw),
      gravityMps2: toBodyAxes(gravityWorld, roll, pitch, yaw),
      angularVelocity: rate[index] ?? [0, 0, 0],
      angularAccel: alpha[index] ?? [0, 0, 0],
      thrustN: Object.fromEntries(
        Object.entries(thrust).flatMap(([id, rotor]) => {
          const value = isRecord(rotor) && Array.isArray(rotor['thrustN']) ? rotor['thrustN'][index] : undefined;
          return typeof value === 'number' ? [[id, value]] : [];
        }),
      ),
    };
  });
}

const norm = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);

/** An instant of the run chosen for export, with what made it the choice. */
export interface ChosenInstant {
  readonly instant: FlightInstant;
  readonly label: string;
}

/**
 * Instants of `at`: a time (the nearest sample), `peak_load` (the largest specific force |a - g|, the load factor the structure carries), or
 * `envelope` (the peaks of specific force, angular velocity and angular acceleration, one case each, equal samples merged).
 */
export function chooseInstants(instants: readonly FlightInstant[], at: number | 'peak_load' | 'envelope'): ChosenInstant[] {
  const argmax = (score: (instant: FlightInstant) => number): FlightInstant =>
    instants.reduce((best, instant) => (score(instant) > score(best) ? instant : best), instants[0] as FlightInstant);
  const specific = (i: FlightInstant): number =>
    norm([i.accelMps2[0] - i.gravityMps2[0], i.accelMps2[1] - i.gravityMps2[1], i.accelMps2[2] - i.gravityMps2[2]]);
  if (typeof at === 'number')
    return [
      {
        instant: instants.reduce(
          (best, i) => (Math.abs(i.timeS - at) < Math.abs(best.timeS - at) ? i : best),
          instants[0] as FlightInstant,
        ),
        label: 't',
      },
    ];
  if (at === 'peak_load') return [{ instant: argmax(specific), label: 'peak' }];
  const picks: ChosenInstant[] = [
    { instant: argmax(specific), label: 'peak_f' },
    { instant: argmax((i) => norm(i.angularVelocity)), label: 'peak_w' },
    { instant: argmax((i) => norm(i.angularAccel)), label: 'peak_a' },
  ];
  return picks.filter((pick, k) => picks.findIndex((other) => other.instant.index === pick.instant.index) === k);
}
