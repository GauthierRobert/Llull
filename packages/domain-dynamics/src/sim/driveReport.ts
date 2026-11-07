/** What a run says about its datasheet motors (PHY-23 TR-DRV-20): peaks and finals per motor, tracking, the energy ledger and the drive warnings. */

import type { SimulationTrace } from '@core/dynamics/physicsEngine';
import type { Motor } from '@core/model/dynamics';
import type { DriveRuntime } from './actuators/block';
import { electricalTimeConstant, isQuasiStatic } from './actuators/dcMotor';
import { checkMotorData } from './actuators/motorData';
import { driveSeries, trackingOf, type DriveSeries, type Tracking } from './actuators/series';
import type { EnergyData } from './energyReport';
import { ledgerOf, type LedgerData } from './ledger';

const last = (values: readonly number[]): number => values[values.length - 1] ?? 0;
const peak = (values: readonly number[]): number => values.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
const rms = (values: readonly number[]): number =>
  Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / Math.max(1, values.length));

/** A tracking error above 1 % of the move (0.5 deg when the reference does not move) is not an inverse-dynamics effort (TR-DRV-11). */
const TRACKING_FRACTION = 0.01;
const TRACKING_FLOOR_RAD = (0.5 * Math.PI) / 180;

interface DriveRunData {
  readonly joint: string;
  readonly mode: string;
  readonly profile: string | null;
  readonly gearRatio: number;
  readonly peak: {
    readonly currentA: number;
    readonly voltageV: number;
    readonly jointTorqueNm: number;
    readonly shaftSpeedRpm: number;
    readonly electricalPowerW: number;
  };
  readonly final: { readonly currentA: number; readonly voltageV: number; readonly jointTorqueNm: number; readonly shaftSpeedRpm: number };
  readonly rms: { readonly currentA: number; readonly jointTorqueNm: number };
  /** Samples where the current limit or the bus voltage clipped the command. */
  readonly limitedSamples: number;
  readonly tracking?: Tracking;
  /** True when the datasheet passed check_motor_data and carries no acceptInconsistent. */
  readonly verified: boolean;
  readonly sourceGrade: string;
  readonly series?: DriveSeries;
}

export interface DriveReport {
  readonly drives: Record<string, DriveRunData>;
  readonly ledger: LedgerData | null;
  readonly warnings: string[];
}

/** Why the effort bound of a speed motor is not credible, or null: no source, or more than 10x the peak effort used by the run. */
export function unboundedEffort(motor: Motor, peakUsed: number | null): string | null {
  if (motor.kind !== 'speed') return null;
  if (motor.source === undefined)
    return `DRV_EFFORT_UNBOUNDED: speed motor '${motor.id}' limits its torque to ${motor.maxTorque} N·m with no motor model and no source; use add_motor kind "dc" or give a sourced limit`;
  if (peakUsed !== null && peakUsed > 0 && motor.maxTorque > 10 * peakUsed)
    return `DRV_EFFORT_UNBOUNDED: speed motor '${motor.id}' bound ${motor.maxTorque} N·m is more than 10x the peak effort used (${peakUsed.toPrecision(3)} N·m)`;
  return null;
}

export function driveReport(
  runs: readonly DriveRuntime[],
  layout: Parameters<typeof ledgerOf>[0],
  trace: SimulationTrace,
  energy: EnergyData | undefined,
  timestep: number,
  withSeries: boolean,
): DriveReport {
  const warnings: string[] = [];
  const drives: Record<string, DriveRunData> = {};
  for (const run of runs) {
    const series = driveSeries(run, trace);
    const tracking = trackingOf(run, trace);
    const check = checkMotorData(run.motor.datasheet);
    const unverified = !check.consistent || run.motor.acceptInconsistent !== undefined;
    drives[run.motor.id] = {
      joint: run.motor.joint,
      mode: run.drive.mode,
      profile: run.drive.profile ?? null,
      gearRatio: run.params.gearRatio,
      peak: {
        currentA: peak(series.currentA),
        voltageV: peak(series.voltageV),
        jointTorqueNm: peak(series.jointTorqueNm),
        shaftSpeedRpm: peak(series.shaftSpeedRpm),
        electricalPowerW: peak(series.electricalPowerW),
      },
      final: {
        currentA: last(series.currentA),
        voltageV: last(series.voltageV),
        jointTorqueNm: last(series.jointTorqueNm),
        shaftSpeedRpm: last(series.shaftSpeedRpm),
      },
      rms: { currentA: rms(series.currentA), jointTorqueNm: rms(series.jointTorqueNm) },
      limitedSamples: series.limited.filter((flag) => flag > 0).length,
      ...(tracking === null ? {} : { tracking }),
      verified: !unverified,
      sourceGrade: run.motor.source.grade,
      ...(withSeries ? { series } : {}),
    };
    if (unverified)
      warnings.push(
        `motor '${run.motor.id}': datasheet checks failed and were accepted (${run.motor.acceptInconsistent ?? 'no reason'}); results are unverified`,
      );
    if (run.params.inductanceH > 0 && isQuasiStatic(run.params, timestep))
      warnings.push(
        `DRV_ELECTRICAL_QUASI_STATIC: motor '${run.motor.id}' electrical time constant ${(electricalTimeConstant(run.params) * 1e6).toPrecision(3)} us is below timestep/50 (${timestep} s): the current is treated as quasi-static`,
      );
    if (tracking !== null && run.drive.mode === 'prescribed') {
      const threshold = tracking.range > 0 ? TRACKING_FRACTION * tracking.range : TRACKING_FLOOR_RAD;
      if (tracking.peakError > threshold)
        warnings.push(
          `DRV_TRACKING_ERROR: prescribed drive of '${run.motor.id}' lagged its profile by up to ${tracking.peakError.toPrecision(3)} ${tracking.unit} (limit ${threshold.toPrecision(3)}): the effort is not the inverse dynamics (raise effortLimit or the current limit)`,
        );
    }
  }
  return { drives, ledger: ledgerOf(layout, trace, energy), warnings };
}
