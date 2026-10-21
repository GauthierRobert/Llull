/**
 * Cylinder pressure as a force law (TR-FPR-08): the gas force acts as the generalised force of the piston's prismatic joint, so the
 * engine applies the equal and opposite reaction to the cylinder body (the joint parent) itself. Pure; the pressure curve of a run is
 * built once (single-zone curves once per 25 rpm of held crank speed, one curve per cycle).
 */

import type { CylinderPressure, DynamicsModel } from '@core/model/dynamics';
import { modelProblem, pressureCurve } from './cylinderPressure';
import { engineLayout, type EngineLayout } from './engineGeometry';
import { gaugeAt, cycleLength, type CurveCode, type PressureCurve } from './pressureCurve';
import type { AppliedLoads, SimulationState } from '@core/dynamics/physicsEngine';
import type { Topology } from './topology';

/** Crank speeds are quantised to this many rpm when a single-zone curve is looked up. */
const RPM_QUANTUM = 25;
/** Speed (rpm) the up-front check of a single-zone curve assumes when the model announces none. */
const CHECK_RPM = 1000;

export interface CylinderRuntime {
  readonly cylinder: CylinderPressure;
  readonly layout: EngineLayout;
  /** Crank joint angle (rad) of the piston's top position (the user's override when given). */
  readonly topAngleRad: number;
  /** deg by which a user `tdcCrankAngleRad` differs from the geometric top (kinematics stay geometric); null when it agrees or is absent. */
  readonly tdcMismatchDeg: number | null;
  /** The pressure curve for a crank speed in rpm. */
  curveAt(rpm: number): PressureCurve;
  /** Crank speed (rpm) the curve of cycle `cycleIndex` is held at: the previous cycle's mean speed, else the initial speed (FMEP rule of §5.8). */
  heldRpm(cycleIndex: number): number;
  /** Record that cycle `cycleIndex` was first seen at `time` (called by the force law, in time order). */
  observe(cycleIndex: number, time: number): void;
}

export interface CylinderRefusal {
  readonly error: string;
  readonly code?: CurveCode;
}

/** A user TDC override further than this from the geometric top is reported (kinematics do not follow the override), deg. */
const TDC_OVERRIDE_TOLERANCE_DEG = 0.1;

const quantised = (rpm: number): number => Math.max(RPM_QUANTUM, Math.round(rpm / RPM_QUANTUM) * RPM_QUANTUM);

/** The runtimes of every cylinder pressure of `dynamics`, or the first reason one cannot be built (nothing is simulated then). */
export function prepareCylinders(
  dynamics: DynamicsModel,
  topology: Topology,
  metresPerUnit: number,
  initialRpm = CHECK_RPM,
): CylinderRuntime[] | CylinderRefusal {
  const runtimes: CylinderRuntime[] = [];
  const cranks = new Set(Object.values(dynamics.cylinders ?? {}).map((cylinder) => cylinder.crank));
  if (cranks.size > 1) return { error: `all cylinders of a run must share one crank joint (found ${[...cranks].join(', ')})` };
  for (const cylinder of Object.values(dynamics.cylinders ?? {})) {
    const problem = modelProblem(cylinder);
    if (problem !== null) return { error: `cylinder '${cylinder.id}': ${problem}` };
    const layout = engineLayout(dynamics, topology, cylinder, metresPerUnit);
    if ('error' in layout) return { error: `cylinder '${cylinder.id}': ${layout.error}` };
    const cache = new Map<number, PressureCurve>();
    const keyOf = (rpm: number): number => (cylinder.model.kind === 'single_zone' ? quantised(rpm) : 0);
    const lookup = (rpm: number): PressureCurve => {
      const known = cache.get(keyOf(rpm));
      if (known !== undefined) return known;
      const built = pressureCurve(cylinder, layout, rpm);
      if ('error' in built) throw new Error(`cylinder '${cylinder.id}': ${built.error}`);
      cache.set(keyOf(rpm), built);
      return built;
    };
    const first = pressureCurve(cylinder, layout, initialRpm);
    if ('error' in first) return { error: `cylinder '${cylinder.id}': ${first.error}`, code: first.code };
    cache.set(keyOf(initialRpm), first);
    const revolutions = cycleLength(cylinder.cycle) / 360;
    const starts = new Map<number, number>();
    const firstSeen: { index: number | null } = { index: null };
    const override = cylinder.tdcCrankAngleRad;
    const difference = override === null ? 0 : ((((override - layout.topCrankAngleRad) % TWO_PI) + 3 * Math.PI) % TWO_PI) - Math.PI;
    const mismatch = Math.abs((difference * 180) / Math.PI) > TDC_OVERRIDE_TOLERANCE_DEG ? (difference * 180) / Math.PI : null;
    runtimes.push({
      cylinder,
      layout,
      topAngleRad: override ?? layout.topCrankAngleRad,
      tdcMismatchDeg: mismatch,
      curveAt: lookup,
      heldRpm: (index) => {
        const [now, before] = [starts.get(index), starts.get(index - 1)];
        return now !== undefined && before !== undefined && index - 1 !== firstSeen.index
          ? (revolutions * 60) / (now - before)
          : initialRpm;
      },
      observe: (index, time) => {
        firstSeen.index ??= index;
        if (!starts.has(index)) starts.set(index, time);
      },
    });
  }
  return runtimes;
}

const TWO_PI = 2 * Math.PI;

export interface CylinderState {
  /** Cycle angle, deg, in [0, cycle). */
  readonly phiDeg: number;
  /** Index of the cycle the crank is in (floor of the unwrapped cycle angle / cycle length). */
  readonly cycleIndex: number;
  /** Gauge pressure, Pa. */
  readonly gaugePa: number;
  /** Gas force on the piston, N, positive toward the crank. */
  readonly forceN: number;
}

/**
 * The cylinder at crank angle `theta` (rad from the t = 0 pose). The pressure curve is held for the whole cycle at the previous cycle's
 * mean speed; pass `observeTime` from the force law to record cycle starts (reports read the same held speeds without recording).
 */
export function cylinderState(runtime: CylinderRuntime, theta: number, observeTime?: number): CylinderState {
  const cycleDeg = cycleLength(runtime.cylinder.cycle);
  const unwrapped = ((theta - runtime.topAngleRad) * 180) / Math.PI + runtime.cylinder.firingOffsetDeg;
  const cycleIndex = Math.floor(unwrapped / cycleDeg);
  if (observeTime !== undefined) runtime.observe(cycleIndex, observeTime);
  const phi = ((unwrapped % cycleDeg) + cycleDeg) % cycleDeg;
  const gauge = gaugeAt(runtime.curveAt(runtime.heldRpm(cycleIndex)), phi);
  return { phiDeg: phi, cycleIndex, gaugePa: gauge, forceN: gauge * runtime.layout.pistonAreaM2 };
}

/** Generalised forces (N) of every cylinder on its piston joint: the gas pushes the piston away from the head. */
function cylinderForces(runtimes: readonly CylinderRuntime[], state: SimulationState): Record<string, number> {
  const forces: Record<string, number> = {};
  for (const runtime of runtimes) {
    const { forceN } = cylinderState(runtime, state.jointPosition[runtime.layout.crankJoint] ?? 0, state.time);
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
