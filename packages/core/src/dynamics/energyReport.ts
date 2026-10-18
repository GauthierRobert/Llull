/**
 * Mechanical energy of a run: kinetic, potential (gravity + joint and point springs), the energy dissipated by joint damping, dry friction
 * and spring dampers, the work put in by motors / servos / gas pressure, and the work absorbed by propellers.
 */

import type { DynamicsModel } from '../model/dynamics';
import { propellerOutput } from './forceLaws';
import type { SimulationTrace } from './physicsEngine';

/** Final values of the energy balance, J. */
export interface EnergyData {
  readonly initialTotalJ: number;
  readonly finalKineticJ: number;
  /** Gravity + joint springs + point springs, referenced to the start pose. */
  readonly finalPotentialJ: number;
  readonly finalTotalJ: number;
  /** Energy turned into heat by joint damping (c·v²), dry friction (f·|v|) and spring dampers up to the end, integrated over the samples (trapezoid). */
  readonly dissipatedJ: number;
  /** Largest |total(t) - total(0)| over the samples, J. */
  readonly maxDeviationJ: number;
  /** maxDeviationJ / the largest kinetic or |potential| energy of the run (0 when nothing moves): conservation check of a lossless run. */
  readonly maxDeviationFraction: number;
  /**
   * Work J put into the mechanism by motors (torque curve and speed governors) and cylinder gas pressure (∫ τ·dθ per driven joint),
   * plus the propeller work below, which the same joints' load torques took back. Absent when the engine does not report it.
   */
  readonly inputWorkJ?: number;
  /** Work J absorbed by propellers (∫ Q·|ω| dt), carried away by the air; part of the balance, not of dissipatedJ. */
  readonly propellerWorkJ?: number;
  /** initial total + inputWorkJ - dissipatedJ - propellerWorkJ - final total, J: zero for a closed balance. */
  readonly balanceErrorJ?: number;
  /** |balanceErrorJ| / the largest of the energies involved (0 when nothing moves). */
  readonly balanceErrorFraction?: number;
}

export interface EnergySeries {
  readonly kinetic: number[];
  readonly potential: number[];
  readonly total: number[];
  readonly dissipated: number[];
  /** Cumulative work put in by motors / servos / gas pressure (see inputWorkJ), empty when the engine does not report it. */
  readonly input: number[];
}

const last = (values: readonly number[]): number => values[values.length - 1] ?? 0;

/** Cumulative trapezoid integral of a power series on the sample times (0 at the first). */
function integrate(times: readonly number[], power: readonly number[]): number[] {
  const cumulative: number[] = [];
  times.forEach((time, i) => {
    const dt = i === 0 ? 0 : time - (times[i - 1] ?? time);
    cumulative.push((cumulative[i - 1] ?? 0) + 0.5 * ((power[i - 1] ?? 0) + (power[i] ?? 0)) * dt);
  });
  return cumulative;
}

/** Cumulative dissipated energy per sample (0 at the first): joint damping and friction, spring dampers. */
function dissipatedSeries(dynamics: DynamicsModel, trace: SimulationTrace): number[] {
  const power = trace.times.map((_, i) => {
    const joints = Object.values(dynamics.joints).reduce((sum, joint) => {
      const v = trace.jointVelocity[joint.id]?.[i] ?? 0;
      return sum + joint.damping * v * v + joint.friction * Math.abs(v);
    }, 0);
    return Object.values(dynamics.springs ?? {}).reduce((sum, spring) => {
      const v = trace.springs?.[spring.id]?.velocity[i] ?? 0;
      return sum + spring.damping * v * v;
    }, joints);
  });
  return integrate(trace.times, power);
}

/** Cumulative work absorbed by the propellers per sample (0 at the first). */
function propellerSeries(dynamics: DynamicsModel, trace: SimulationTrace): number[] {
  const power = trace.times.map((_, i) =>
    Object.values(dynamics.propellers).reduce(
      (sum, propeller) => sum + propellerOutput(propeller, trace.jointVelocity[propeller.joint]?.[i] ?? 0).power,
      0,
    ),
  );
  return integrate(trace.times, power);
}

/** The energy balance of a run, or null when the engine recorded no energy. */
export function energyOf(dynamics: DynamicsModel, trace: SimulationTrace): { data: EnergyData; series: EnergySeries } | null {
  if (trace.energy === undefined || trace.times.length === 0) return null;
  const { kinetic, potential, appliedWork } = trace.energy;
  const total = kinetic.map((k, i) => k + (potential[i] ?? 0));
  const dissipated = dissipatedSeries(dynamics, trace);
  const propeller = propellerSeries(dynamics, trace);
  const input = appliedWork === undefined ? [] : appliedWork.map((w, i) => w + (propeller[i] ?? 0));
  const initial = total[0] ?? 0;
  const deviation = total.reduce((worst, e) => Math.max(worst, Math.abs(e - initial)), 0);
  const scale = Math.max(0, ...kinetic, ...potential.map(Math.abs));
  const balance =
    appliedWork === undefined
      ? {}
      : (() => {
          const [inputJ, lossJ, propellerJ] = [last(input), last(dissipated), last(propeller)];
          const error = initial + inputJ - lossJ - propellerJ - last(total);
          const largest = Math.max(scale, Math.abs(initial), Math.abs(inputJ), lossJ, propellerJ);
          return {
            inputWorkJ: inputJ,
            propellerWorkJ: propellerJ,
            balanceErrorJ: error,
            balanceErrorFraction: largest > 0 ? Math.abs(error) / largest : 0,
          };
        })();
  return {
    data: {
      initialTotalJ: initial,
      finalKineticJ: last(kinetic),
      finalPotentialJ: last(potential),
      finalTotalJ: last(total),
      dissipatedJ: last(dissipated),
      maxDeviationJ: deviation,
      maxDeviationFraction: scale > 0 ? deviation / scale : 0,
      ...balance,
    },
    series: { kinetic, potential, total, dissipated, input },
  };
}
