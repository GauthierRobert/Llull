/** Mechanical energy of a run: kinetic, potential (gravity + joint springs) and the energy dissipated by joint damping and dry friction. */

import type { DynamicsModel } from '../model/dynamics';
import type { SimulationTrace } from './physicsEngine';

/** Final values of the energy balance, J. */
export interface EnergyData {
  readonly initialTotalJ: number;
  readonly finalKineticJ: number;
  /** Gravity + joint springs, referenced to the start pose. */
  readonly finalPotentialJ: number;
  readonly finalTotalJ: number;
  /** Energy turned into heat by joint damping (c·v²) and dry friction (f·|v|) up to the end, integrated over the samples (trapezoid). */
  readonly dissipatedJ: number;
  /** Largest |total(t) - total(0)| over the samples, J. */
  readonly maxDeviationJ: number;
  /** maxDeviationJ / the largest kinetic or |potential| energy of the run (0 when nothing moves): conservation check of a lossless run. */
  readonly maxDeviationFraction: number;
}

export interface EnergySeries {
  readonly kinetic: number[];
  readonly potential: number[];
  readonly total: number[];
  readonly dissipated: number[];
}

const last = (values: readonly number[]): number => values[values.length - 1] ?? 0;

/** Cumulative dissipated energy per sample (0 at the first). */
function dissipatedSeries(dynamics: DynamicsModel, trace: SimulationTrace): number[] {
  const power = trace.times.map((_, i) =>
    Object.values(dynamics.joints).reduce((sum, joint) => {
      const v = trace.jointVelocity[joint.id]?.[i] ?? 0;
      return sum + joint.damping * v * v + joint.friction * Math.abs(v);
    }, 0),
  );
  const cumulative: number[] = [];
  trace.times.forEach((time, i) => {
    const before = cumulative[i - 1] ?? 0;
    const dt = i === 0 ? 0 : time - (trace.times[i - 1] ?? time);
    cumulative.push(before + 0.5 * ((power[i - 1] ?? 0) + (power[i] ?? 0)) * dt);
  });
  return cumulative;
}

/** The energy balance of a run, or null when the engine recorded no energy. */
export function energyOf(dynamics: DynamicsModel, trace: SimulationTrace): { data: EnergyData; series: EnergySeries } | null {
  if (trace.energy === undefined || trace.times.length === 0) return null;
  const { kinetic, potential } = trace.energy;
  const total = kinetic.map((k, i) => k + (potential[i] ?? 0));
  const dissipated = dissipatedSeries(dynamics, trace);
  const initial = total[0] ?? 0;
  const deviation = total.reduce((worst, e) => Math.max(worst, Math.abs(e - initial)), 0);
  const scale = Math.max(0, ...kinetic, ...potential.map(Math.abs));
  return {
    data: {
      initialTotalJ: initial,
      finalKineticJ: last(kinetic),
      finalPotentialJ: last(potential),
      finalTotalJ: last(total),
      dissipatedJ: last(dissipated),
      maxDeviationJ: deviation,
      maxDeviationFraction: scale > 0 ? deviation / scale : 0,
    },
    series: { kinetic, potential, total, dissipated },
  };
}
