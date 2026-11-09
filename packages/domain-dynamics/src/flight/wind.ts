/** World air velocity of a flight scenario (TR-FLT-04, steady + 1-cosine gusts) and the body state the flight laws read under it. */

import type { BodyKinematics } from '@core/dynamics/physicsEngine';
import type { Vec3 } from '@core/model/vectors';
import { sub3 } from '@lib/vec3';
import type { FlightWind } from './controlModel';
import { drydenSeries, TURBULENCE_STEP_S } from './turbulence';

/** Air velocity at time `t`, m/s, world: steady + Σ (peak/2)(1 - cos(2π(t - t0)/T)) over the gusts active at t. */
export function windAt(wind: FlightWind, t: number): Vec3 {
  let [x, y, z] = wind.steady;
  for (const gust of wind.gusts) {
    const phase = (t - gust.startS) / gust.durationS;
    if (phase < 0 || phase > 1) continue;
    const shape = 0.5 * (1 - Math.cos(2 * Math.PI * phase));
    x += gust.peak[0] * shape;
    y += gust.peak[1] * shape;
    z += gust.peak[2] * shape;
  }
  return [x, y, z];
}

/** True when the scenario has no wind at all (the laws then read the body state as is). */
export const isCalm = (wind: FlightWind): boolean =>
  wind.gusts.length === 0 && wind.turbulence === undefined && wind.steady.every((component) => component === 0);

/** World air velocity as a function of time, m/s. */
export type WindSource = (time: number) => Vec3;

/**
 * The wind of a run lasting `durationS`: steady + gusts + the seeded Dryden turbulence realised once for the whole run (linear between its
 * samples every TURBULENCE_STEP_S, held after the last). Deterministic: the same wind gives the same series.
 */
export function windSource(wind: FlightWind, durationS: number): WindSource {
  const { turbulence } = wind;
  if (turbulence === undefined) return (time) => windAt(wind, time);
  const series = drydenSeries(turbulence, Math.ceil(durationS / TURBULENCE_STEP_S) + 2);
  return (time) => {
    const base = windAt(wind, time);
    const position = Math.max(0, time) / TURBULENCE_STEP_S;
    const i = Math.min(series.length - 1, Math.floor(position));
    const t = Math.min(1, position - i);
    const a = series[i] ?? [0, 0, 0];
    const b = series[Math.min(i + 1, series.length - 1)] ?? a;
    return [base[0] + a[0] + (b[0] - a[0]) * t, base[1] + a[1] + (b[1] - a[1]) * t, base[2] + a[2] + (b[2] - a[2]) * t];
  };
}

/** `body` with its velocity taken relative to air moving at `air` (rotor inflow and drag see the relative wind). */
export function airRelative(body: BodyKinematics, air: Vec3): BodyKinematics {
  return { ...body, linearVelocity: sub3(body.linearVelocity, air) };
}
