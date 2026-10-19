/**
 * Engine mechanical losses as a force law (FR-FPR-71, TR-FPR-15, TECHNICAL_SPEC 5.8). FMEP is evaluated once per cycle at the mean speed of
 * the previous cycle (`CylinderRuntime.heldRpm`) and, for Chen-Flynn, the peak pressure of that cycle's curve. It acts as a torque on the
 * crank against its rotation, T_f = -FMEP V_d / (4 pi) tanh(w / w_s) (2 pi for a two-stroke), so the cycle average at steady speed is
 * exactly FMEP V_d / (4 pi). `component` (PNH / Sandoval-Heywood) is not implemented (TECHNICAL_SPEC 11 Q8).
 */

import type { EngineLosses } from '../../model/dynamics';
import type { AppliedLoads, SimulationState } from '../physicsEngine';
import { cylinderState, type CylinderRuntime } from '../cylinderLoads';
import type { AccuracyBand } from '../accuracy';

/** Speed below which the loss torque is smoothed (named, TR-FPR-15), rad/s. */
const FRICTION_SMOOTHING_RAD_S = 1;
/** Mean error of the Chen-Flynn fit against measured FMEP [E-R10] (the maximum was 35 %). */
const CHEN_FLYNN_MEAN_ERROR = 0.13;

export interface FmepValue {
  /** Pa, oil-temperature factor included. */
  readonly pa: number;
  /** The speed lies outside a tabulated FMEP range (FPR_OUTSIDE_VALIDATED_RANGE). */
  readonly outsideRange: boolean;
}

/** FMEP of `losses` at `rpm` and absolute peak cylinder pressure `peakPa`. */
export function fmepAt(losses: EngineLosses, rpm: number, peakPa: number): FmepValue {
  const { model } = losses;
  if (model.kind === 'chen_flynn')
    return {
      pa: losses.oilTempFactor * (model.aPa + model.bRatio * peakPa + model.cPaPerRpm * rpm + model.dPaPerRpm2 * rpm * rpm),
      outsideRange: false,
    };
  const points = [...model.points].sort((a, b) => a[0] - b[0]);
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return { pa: 0, outsideRange: true };
  if (rpm <= first[0]) return { pa: losses.oilTempFactor * first[1], outsideRange: rpm < first[0] };
  if (rpm >= last[0]) return { pa: losses.oilTempFactor * last[1], outsideRange: rpm > last[0] };
  const upper = points.findIndex((point) => point[0] >= rpm);
  const [a, b] = [points[upper - 1] ?? first, points[upper] ?? last];
  return { pa: losses.oilTempFactor * (a[1] + ((b[1] - a[1]) * (rpm - a[0])) / (b[0] - a[0])), outsideRange: false };
}

/** The stated accuracy of the friction model (FR-FPR-71): Chen-Flynn 13 % mean [E-R10]; a user table states none. */
export function fmepBand(losses: EngineLosses): { band: AccuracyBand; basis: string } {
  return losses.model.kind === 'chen_flynn'
    ? {
        band: { rel: CHEN_FLYNN_MEAN_ERROR },
        basis: `Chen-Flynn fit, 13 % mean / 35 % max error against measured FMEP [E-R10]; constants: ${losses.model.source}`,
      }
    : { band: null, basis: `fmep_table supplied by the user, no uncertainty stated: ${losses.model.source}` };
}

interface LossState {
  readonly losses: EngineLosses;
  readonly runtimes: readonly CylinderRuntime[];
  /** Swept volume of the listed cylinders, m³. */
  readonly displacementM3: number;
  /** rad of crank per cycle (4 pi four-stroke, 2 pi two-stroke). */
  readonly cycleRad: number;
  /** Crank speed (rpm) the FMEP is evaluated at, the peak pressure (Pa) and the FMEP. */
  readonly rpm: number;
  readonly peakPa: number;
  readonly fmep: FmepValue;
}

/** True when `cylinder` is one of the cylinders `losses` reads (an empty list means every cylinder on its crank). */
export function ownsCylinder(losses: EngineLosses, cylinder: { readonly id: string; readonly crank: string }): boolean {
  return cylinder.crank === losses.crank && (losses.cylinders.length === 0 || losses.cylinders.includes(cylinder.id));
}

/** The loss state at crank angle `theta` (rad from the t = 0 pose), or null when none of its cylinders has a runtime. */
function lossStateAt(losses: EngineLosses, runtimes: readonly CylinderRuntime[], theta: number): LossState | null {
  const own = runtimes.filter((runtime) => ownsCylinder(losses, runtime.cylinder));
  const lead = own[0];
  if (lead === undefined) return null;
  const { cycleIndex } = cylinderState(lead, theta);
  const rpm = lead.heldRpm(cycleIndex);
  const peakPa = Math.max(...own.map((runtime) => runtime.curveAt(rpm).peakPa));
  return {
    losses,
    runtimes: own,
    displacementM3: own.reduce((total, runtime) => total + runtime.layout.displacementM3, 0),
    cycleRad: lead.cylinder.cycle === 'four_stroke' ? 4 * Math.PI : 2 * Math.PI,
    rpm,
    peakPa,
    fmep: fmepAt(losses, rpm, peakPa),
  };
}

/** Mean friction torque (N·m, positive magnitude) of a loss state: FMEP V_d / cycle angle. */
const meanFrictionTorque = (state: LossState): number => (state.fmep.pa * state.displacementM3) / state.cycleRad;

/** `base` loads plus the friction torque of every engine-loss record on its crank. Applied after the cylinder forces so the cycle is observed. */
export function withEngineLosses(
  base: (state: SimulationState) => AppliedLoads,
  records: readonly EngineLosses[],
  runtimes: readonly CylinderRuntime[],
): (state: SimulationState) => AppliedLoads {
  if (records.length === 0) return base;
  return (state) => {
    const loads = base(state);
    const jointForces: Record<string, number> = { ...loads.jointForces };
    for (const record of records) {
      const loss = lossStateAt(record, runtimes, state.jointPosition[record.crank] ?? 0);
      if (loss === null) continue;
      const omega = state.jointVelocity[record.crank] ?? 0;
      jointForces[record.crank] = (jointForces[record.crank] ?? 0) - meanFrictionTorque(loss) * Math.tanh(omega / FRICTION_SMOOTHING_RAD_S);
    }
    return { jointForces, bodyForces: loads.bodyForces };
  };
}
