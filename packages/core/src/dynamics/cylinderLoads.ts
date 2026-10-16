/**
 * Cylinder pressure as a force law (TR-FPR-08): the gas force acts as the generalised force of the piston's prismatic joint, so the
 * engine applies the equal and opposite reaction to the cylinder body (the joint parent) itself. Pure; the pressure curve of a run is
 * built once (single-zone curves once per 25 rpm of crank speed).
 */

import type { CylinderPressure, DynamicsModel } from '../model/dynamics';
import { modelProblem, pressureCurve } from './cylinderPressure';
import { engineLayout, type EngineLayout } from './engineGeometry';
import { gaugeAt, cycleLength, type CurveCode, type PressureCurve } from './pressureCurve';
import type { AppliedLoads, SimulationState } from './physicsEngine';
import type { Topology } from './topology';

/** Crank speeds are quantised to this many rpm when a single-zone curve is looked up. */
const RPM_QUANTUM = 25;
/** Speed (rpm) the up-front check of a single-zone curve assumes when the model announces none. */
const CHECK_RPM = 1000;

export interface CylinderRuntime {
  readonly cylinder: CylinderPressure;
  readonly layout: EngineLayout;
  /** Crank joint angle (rad) of the piston's top position. */
  readonly topAngleRad: number;
  /** The pressure curve for a crank speed in rpm. */
  curveAt(rpm: number): PressureCurve;
}

export interface CylinderRefusal {
  readonly error: string;
  readonly code?: CurveCode;
}

/** The runtimes of every cylinder pressure of `dynamics`, or the first reason one cannot be built (nothing is simulated then). */
export function prepareCylinders(
  dynamics: DynamicsModel,
  topology: Topology,
  metresPerUnit: number,
  checkRpm = CHECK_RPM,
): CylinderRuntime[] | CylinderRefusal {
  const runtimes: CylinderRuntime[] = [];
  for (const cylinder of Object.values(dynamics.cylinders ?? {})) {
    const problem = modelProblem(cylinder);
    if (problem !== null) return { error: `cylinder '${cylinder.id}': ${problem}` };
    const layout = engineLayout(dynamics, topology, cylinder, metresPerUnit);
    if ('error' in layout) return { error: `cylinder '${cylinder.id}': ${layout.error}` };
    const cache = new Map<number, PressureCurve>();
    const lookup = (rpm: number): PressureCurve => {
      const key = cylinder.model.kind === 'single_zone' ? Math.max(RPM_QUANTUM, Math.round(rpm / RPM_QUANTUM) * RPM_QUANTUM) : 0;
      const known = cache.get(key);
      if (known !== undefined) return known;
      const built = pressureCurve(cylinder, layout, key === 0 ? checkRpm : key);
      if ('error' in built) throw new Error(`cylinder '${cylinder.id}': ${built.error}`);
      cache.set(key, built);
      return built;
    };
    const first = pressureCurve(cylinder, layout, checkRpm);
    if ('error' in first) return { error: `cylinder '${cylinder.id}': ${first.error}`, code: first.code };
    cache.set(cylinder.model.kind === 'single_zone' ? Math.max(RPM_QUANTUM, Math.round(checkRpm / RPM_QUANTUM) * RPM_QUANTUM) : 0, first);
    runtimes.push({ cylinder, layout, topAngleRad: cylinder.tdcCrankAngleRad ?? layout.topCrankAngleRad, curveAt: lookup });
  }
  return runtimes;
}

export interface CylinderState {
  /** Cycle angle, deg, in [0, cycle). */
  readonly phiDeg: number;
  /** Gauge pressure, Pa. */
  readonly gaugePa: number;
  /** Gas force on the piston, N, positive toward the crank. */
  readonly forceN: number;
}

/** The cylinder at crank angle `theta` (rad from the t = 0 pose) turning at `omega` (rad/s). */
export function cylinderState(runtime: CylinderRuntime, theta: number, omega: number): CylinderState {
  const cycleDeg = cycleLength(runtime.cylinder.cycle);
  const rpm = (Math.abs(omega) * 60) / (2 * Math.PI);
  const phi = (((((theta - runtime.topAngleRad) * 180) / Math.PI + runtime.cylinder.firingOffsetDeg) % cycleDeg) + cycleDeg) % cycleDeg;
  const gauge = gaugeAt(runtime.curveAt(rpm), phi);
  return { phiDeg: phi, gaugePa: gauge, forceN: gauge * runtime.layout.pistonAreaM2 };
}

/** Generalised forces (N) of every cylinder on its piston joint: the gas pushes the piston away from the head. */
function cylinderForces(runtimes: readonly CylinderRuntime[], state: SimulationState): Record<string, number> {
  const forces: Record<string, number> = {};
  for (const runtime of runtimes) {
    const { forceN } = cylinderState(
      runtime,
      state.jointPosition[runtime.layout.crankJoint] ?? 0,
      state.jointVelocity[runtime.layout.crankJoint] ?? 0,
    );
    forces[runtime.layout.pistonJoint] = (forces[runtime.layout.pistonJoint] ?? 0) - runtime.layout.headSign * forceN;
  }
  return forces;
}

/** `base` loads plus the cylinder gas forces. */
export function withCylinderForces(
  base: (state: SimulationState) => AppliedLoads,
  runtimes: readonly CylinderRuntime[],
): (state: SimulationState) => AppliedLoads {
  return (state) => {
    const loads = base(state);
    const gas = cylinderForces(runtimes, state);
    const jointForces: Record<string, number> = { ...loads.jointForces };
    for (const [joint, force] of Object.entries(gas)) jointForces[joint] = (jointForces[joint] ?? 0) + force;
    return { jointForces, bodyForces: loads.bodyForces };
  };
}
