/** Per-motor series and summary of a run (PHY-23 TR-DRV-20), read from the actuator `aux` slots the engine recorded. */

import type { SimulationTrace } from '@core/dynamics/physicsEngine';
import { RAD_PER_S_PER_RPM } from '../forceLaws';
import type { DriveRuntime } from './block';
import { AUX } from './controller';

export interface DriveSeries {
  readonly times: number[];
  readonly voltageV: number[];
  readonly currentA: number[];
  /** N·m at the motor shaft (kt · mean current for dc; the machine torque otherwise). */
  readonly shaftTorqueNm: number[];
  /** N·m on the driven joint. */
  readonly jointTorqueNm: number[];
  readonly shaftSpeedRpm: number[];
  readonly electricalPowerW: number[];
  readonly mechanicalPowerW: number[];
  /** 1 while the current limit (or the bus voltage) clipped the command in the last step. */
  readonly limited: number[];
}

const slot = (trace: SimulationTrace, run: DriveRuntime, offset: number): number[] => trace.aux?.[run.base + offset] ?? [];

/** The recorded series of one driven motor. Slot values at a sample are the outputs of the step that ended there (zero at t = 0). */
export function driveSeries(run: DriveRuntime, trace: SimulationTrace): DriveSeries {
  const speed = (trace.jointVelocity[run.motor.joint] ?? []).map((v) => v * run.params.gearRatio);
  const [voltage, power, shaft, joint, limited, current] = [
    AUX.voltage,
    AUX.power,
    AUX.shaftTorque,
    AUX.jointTorque,
    AUX.limited,
    AUX.current,
  ].map((offset) => slot(trace, run, offset));
  const at = (series: readonly number[] | undefined, i: number): number => series?.[i] ?? 0;
  return {
    times: trace.times,
    voltageV: voltage ?? [],
    currentA: current ?? [],
    shaftTorqueNm: shaft ?? [],
    jointTorqueNm: joint ?? [],
    shaftSpeedRpm: speed.map((w) => w / RAD_PER_S_PER_RPM),
    electricalPowerW: trace.times.map((_, i) => at(power, i)),
    mechanicalPowerW: trace.times.map((_, i) => at(shaft, i) * (speed[i] ?? 0)),
    limited: limited ?? [],
  };
}

export interface Tracking {
  readonly unit: 'rad' | 'rad/s' | 'm' | 'm/s';
  readonly rmsError: number;
  readonly peakError: number;
  /** Peak-to-peak of the reference, same unit. */
  readonly range: number;
}

/** Tracking error of a closed-loop drive (reference minus measurement at every sample after the first). */
export function trackingOf(run: DriveRuntime, trace: SimulationTrace): Tracking | null {
  if (run.loop === null) return null;
  const reference = slot(trace, run, AUX.reference).slice(1);
  const measured = slot(trace, run, AUX.measured).slice(1);
  if (reference.length === 0) return null;
  const errors = reference.map((value, i) => value - (measured[i] ?? 0));
  return {
    unit: run.loop.quantity === 'position' ? 'rad' : 'rad/s',
    rmsError: Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length),
    peakError: Math.max(...errors.map(Math.abs)),
    range: Math.max(...reference) - Math.min(...reference),
  };
}
