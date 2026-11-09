/**
 * Aero surfaces and pivot servos inside the flight block (13 FLT M4): per step the servo of each surface moves toward the scenario's pivot command
 * at its rate limit, the table law gives the wrench at the mean pivot angle of the step, and the block keeps exact per-step peaks in its aux slots.
 */

import type { BodyKinematics } from '@core/dynamics/physicsEngine';
import type { Vec3 } from '@core/model/vectors';
import { add3 } from '@lib/vec3';
import type { FlightScenario } from './controlModel';
import { aeroOutput, neutralPivotDeg, type AeroRuntime } from './aeroSurface';

/** Per surface: pivot angle deg, angle of attack deg, CL, CD, lift N, drag N, steps outside the table, α min, α max, peak |lift| N, time of the peak. */
export const AERO = {
  pivot: 0,
  alpha: 1,
  cl: 2,
  cd: 3,
  lift: 4,
  drag: 5,
  outsideSteps: 6,
  minAlpha: 7,
  maxAlpha: 8,
  peakLift: 9,
  peakLiftTime: 10,
} as const;
export const AERO_SLOTS = 11;

/** Pivot command of surface `id` at time t: the last set-point at or before t that names it, else `fallback`, deg. */
export function pivotCommand(scenario: FlightScenario, id: string, t: number, fallback: number): number {
  let command = fallback;
  for (const setpoint of scenario.setpoints) {
    if (setpoint.t > t + 1e-9) break;
    const named = setpoint.pivotDeg !== undefined && Object.hasOwn(setpoint.pivotDeg, id) ? setpoint.pivotDeg[id] : undefined;
    if (named !== undefined) command = named;
  }
  return command;
}

const clampTo = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

/** Initial aux of the surfaces at `base`: the servo at its t = 0 command (clamped to its limits), no peaks. */
export function initialAeroAux(surfaces: readonly AeroRuntime[], scenario: FlightScenario, aux: Float64Array, base: number): void {
  surfaces.forEach((runtime, i) => {
    const { servo } = runtime.surface;
    const at = base + AERO_SLOTS * i;
    const start = pivotCommand(scenario, runtime.surface.id, 0, neutralPivotDeg(runtime.surface));
    aux[at + AERO.pivot] = servo === null ? 0 : clampTo(start, servo.minDeg, servo.maxDeg);
    aux[at + AERO.minAlpha] = Infinity;
    aux[at + AERO.maxAlpha] = -Infinity;
  });
}

/**
 * Advance the surfaces one step of `dt` at `time`: servo toward its command, wrench from the (air-relative) state of the body each rides on.
 * Returns the summed force / moment per body id.
 */
export function stepAero(
  surfaces: readonly AeroRuntime[],
  scenario: FlightScenario,
  aux: Float64Array,
  base: number,
  time: number,
  dt: number,
  bodyOf: (bodyId: string) => BodyKinematics | undefined,
  into: { readonly forces: Record<string, Vec3>; readonly moments: Record<string, Vec3> },
): void {
  surfaces.forEach((runtime, i) => {
    const { surface } = runtime;
    const at = base + AERO_SLOTS * i;
    const { servo } = surface;
    const before = aux[at + AERO.pivot] as number;
    let after = before;
    if (servo !== null) {
      const target = clampTo(pivotCommand(scenario, surface.id, time, before), servo.minDeg, servo.maxDeg);
      const reach = servo.rateDegS * dt;
      after = before + clampTo(target - before, -reach, reach);
    }
    aux[at + AERO.pivot] = after;
    const body = bodyOf(surface.bodyId);
    if (body === undefined) return;
    const out = aeroOutput(runtime, body, 0.5 * (before + after));
    into.forces[surface.bodyId] = add3(into.forces[surface.bodyId] ?? [0, 0, 0], out.force);
    into.moments[surface.bodyId] = add3(into.moments[surface.bodyId] ?? [0, 0, 0], out.moment);
    aux[at + AERO.alpha] = out.alphaDeg;
    aux[at + AERO.cl] = out.cl;
    aux[at + AERO.cd] = out.cd;
    aux[at + AERO.lift] = out.liftN;
    aux[at + AERO.drag] = out.dragN;
    if (out.outside) aux[at + AERO.outsideSteps] = (aux[at + AERO.outsideSteps] as number) + 1;
    aux[at + AERO.minAlpha] = Math.min(aux[at + AERO.minAlpha] as number, out.alphaDeg);
    aux[at + AERO.maxAlpha] = Math.max(aux[at + AERO.maxAlpha] as number, out.alphaDeg);
    if (Math.abs(out.liftN) > (aux[at + AERO.peakLift] as number)) {
      aux[at + AERO.peakLift] = Math.abs(out.liftN);
      aux[at + AERO.peakLiftTime] = time;
    }
  });
}
