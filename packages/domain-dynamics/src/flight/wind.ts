/** World air velocity of a flight scenario (TR-FLT-04, steady + 1-cosine gusts) and the body state the flight laws read under it. */

import type { BodyKinematics } from '@core/dynamics/physicsEngine';
import type { Vec3 } from '@core/model/vectors';
import { sub3 } from '@lib/vec3';
import type { FlightWind } from './controlModel';

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
export const isCalm = (wind: FlightWind): boolean => wind.gusts.length === 0 && wind.steady.every((component) => component === 0);

/** `body` with its velocity taken relative to air moving at `air` (rotor inflow and drag see the relative wind). */
export function airRelative(body: BodyKinematics, air: Vec3): BodyKinematics {
  return { ...body, linearVelocity: sub3(body.linearVelocity, air) };
}
