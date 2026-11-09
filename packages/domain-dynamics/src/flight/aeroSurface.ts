/** Aero surface law (13 FLT M4, TR-FLT-03): table coefficients at the flow seen by the moment centre, as a world wrench on the body. */

import type { BodyKinematics } from '@core/dynamics/physicsEngine';
import type { Vec3 } from '@core/model/vectors';
import { add3, cross3, dot3, scale3, sub3 } from '@lib/vec3';
import { flowFrame, type AeroSurface } from './aeroModel';
import { lookupAero } from './aeroTable';
import { rotate, rotateInverse } from './frames';

const DEG = 180 / Math.PI;

/** A surface compiled for one run: the moment centre as an arm from the body's centre of mass, m, body axes. */
export interface AeroRuntime {
  readonly surface: AeroSurface;
  readonly arm: Vec3;
  readonly frame: ReturnType<typeof flowFrame>;
}

/** Pivot angle of a surface without a scenario command: the servo's neutral angle, 0 for a surface that does not pivot. */
export const neutralPivotDeg = (surface: AeroSurface): number => (surface.servo === null ? 0 : surface.servo.neutralDeg);

export function compileAero(surface: AeroSurface, centerOfMass: Vec3, metresPerUnit: number): AeroRuntime {
  return { surface, arm: sub3(scale3(surface.momentCentre, metresPerUnit), centerOfMass), frame: flowFrame(surface.forward) };
}

export interface AeroOutput {
  readonly alphaDeg: number;
  readonly cl: number;
  readonly cd: number;
  /** q·S·CL and q·S·CD, N. */
  readonly liftN: number;
  readonly dragN: number;
  /** α or the pivot angle outside the table (coefficients held at its edge). */
  readonly outside: boolean;
  /** World force at the moment centre, N. */
  readonly force: Vec3;
  /** World moment about the body's centre of mass: r × F plus the pitching moment, N·m. */
  readonly moment: Vec3;
}

const NONE: AeroOutput = { alphaDeg: 0, cl: 0, cd: 0, liftN: 0, dragN: 0, outside: false, force: [0, 0, 0], moment: [0, 0, 0] };

/**
 * Wrench of the surface at the body state `body` (velocity relative to the air) with the pivot at `pivotDeg`: the air velocity at the moment centre
 * u = −(v + ω × r) is split on the flow frame (ux downstream, uz up), α = atan2(uz, ux), q = ½ρ(ux² + uz²); F = q·S·[CD cos α − CL sin α, 0,
 * CD sin α + CL cos α] in the flow frame (drag along the flow, lift across it), moment q·S·c·CM about the spanwise axis. No flow, or flow from the downstream side (ux <= 0), gives no wrench (the latter flagged outside).
 */
export function aeroOutput(runtime: AeroRuntime, body: BodyKinematics, pivotDeg: number): AeroOutput {
  const { surface, frame } = runtime;
  const arm = rotate(body.orientation, runtime.arm);
  const air = scale3(rotateInverse(body.orientation, add3(body.linearVelocity, cross3(body.angularVelocity, arm))), -1);
  const ux = dot3(air, frame.x);
  const uz = dot3(air, frame.z);
  const speedSquared = ux * ux + uz * uz;
  if (speedSquared < 1e-12) return NONE;
  // flow coming from the downstream side (|α| > 90°): the table does not describe it, so no force and the step counts as outside the table
  if (ux <= 0) return { ...NONE, alphaDeg: Math.atan2(uz, ux) * DEG, outside: true };
  const alpha = Math.atan2(uz, ux);
  const alphaDeg = alpha * DEG;
  const { cl, cd, cm, outside } = lookupAero(surface.table, alphaDeg, pivotDeg);
  const qs = 0.5 * surface.airDensity * speedSquared * surface.refAreaM2;
  const fx = qs * (cd * Math.cos(alpha) - cl * Math.sin(alpha));
  const fz = qs * (cd * Math.sin(alpha) + cl * Math.cos(alpha));
  const force = rotate(body.orientation, add3(scale3(frame.x, fx), scale3(frame.z, fz)));
  const pitch = rotate(body.orientation, scale3(frame.y, qs * surface.refChordM * cm));
  return { alphaDeg, cl, cd, liftN: qs * cl, dragN: qs * cd, outside, force, moment: add3(cross3(arm, force), pitch) };
}
