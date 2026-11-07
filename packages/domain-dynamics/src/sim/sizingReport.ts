/**
 * What one motor is asked to do over a duty cycle and whether it can (PHY-23 TR-DRV-21 / 22 / 09): demand (peaks, RMS over the window), capacity
 * (datasheet limits and the thermal network), the margin of each against the other, the limiting factor and the coded findings.
 */

import type { DcMotor } from '@core/model/drives';
import type { DriveRunData } from './driveReport';
import { checkMotorData } from './actuators/motorData';
import {
  continuousCurrentAtLimit,
  networkTimeConstants,
  runawayCurrent,
  steadyWindingC,
  thermalParams,
  windingTemperatureSeries,
} from './actuators/thermal';
import { marginOf, peakAbs, rmsOver } from './sizing';
import { trackingLimit } from './driveReport';

type FindingStatus = 'fail' | 'warn' | 'info';

export interface SizingFinding {
  readonly code: string;
  readonly status: FindingStatus;
  readonly ids: readonly string[];
  readonly value?: number;
  readonly limit?: number;
  readonly fix: string;
}

export type Factor = 'peak_current' | 'rms_current' | 'speed' | 'thermal';

interface Capacity {
  readonly peakCurrentA: { readonly value: number; readonly basis: string };
  readonly continuousCurrentA: { readonly value: number; readonly basis: string } | null;
  readonly maxSpeedRpm: number | null;
  readonly windingMaxC: number | null;
}

interface MotorDemand {
  readonly peakCurrentA: number;
  readonly rmsCurrentA: number;
  readonly peakShaftTorqueNm: number;
  readonly rmsShaftTorqueNm: number;
  readonly peakJointTorqueNm: number;
  readonly peakSpeedRpm: number;
  readonly peakVoltageV: number;
  readonly peakElectricalPowerW: number;
  /** Samples where the current limit or the bus voltage clipped the command. */
  readonly limitedSamples: number;
}

interface ThermalReport {
  readonly steadyAtRmsC: number | null;
  readonly runaway: boolean;
  readonly runawayCurrentA: number;
  readonly maxContinuousCurrentA: number;
  readonly peakWindingC: number;
  readonly endWindingC: number;
  readonly timeConstantsS: { readonly network: readonly [number, number]; readonly datasheet: readonly [number, number] };
}

export interface SizingReport {
  readonly demand: MotorDemand;
  readonly capacity: Capacity;
  /** capacity / demand - 1 per factor; absent factors were not evaluated (no datasheet value / no demand). */
  readonly margins: Partial<Record<Factor, number>>;
  readonly limiting: { readonly factor: Factor; readonly margin: number } | null;
  readonly thermal: ThermalReport | null;
  readonly findings: readonly SizingFinding[];
  readonly verdict: 'ok' | 'marginal' | 'over';
  readonly notEvaluated: readonly string[];
}

const finding = (
  code: string,
  status: FindingStatus,
  ids: readonly string[],
  fix: string,
  numbers: { value?: number; limit?: number } = {},
): SizingFinding => ({ code, status, ids, fix, ...numbers });

/** Demand of a driven motor from its run series (the series of simulate_motion detail "drives"). */
function demandOf(run: DriveRunData): MotorDemand | null {
  const series = run.series;
  if (series === undefined || series.times.length < 2) return null;
  return {
    peakCurrentA: peakAbs(series.currentA),
    rmsCurrentA: rmsOver(series.times, series.currentA),
    peakShaftTorqueNm: peakAbs(series.shaftTorqueNm),
    rmsShaftTorqueNm: rmsOver(series.times, series.shaftTorqueNm),
    peakJointTorqueNm: peakAbs(series.jointTorqueNm),
    peakSpeedRpm: peakAbs(series.shaftSpeedRpm),
    peakVoltageV: peakAbs(series.voltageV),
    peakElectricalPowerW: peakAbs(series.electricalPowerW),
    limitedSamples: series.limited.filter((flag) => flag > 0).length,
  };
}

function capacityOf(motor: DcMotor): Capacity {
  const sheet = motor.datasheet;
  const thermal = thermalParams(sheet);
  const stall = sheet.nominalVoltageV / sheet.terminalResistanceOhm;
  return {
    peakCurrentA:
      sheet.peakCurrentA === undefined
        ? { value: stall, basis: 'stall current U / R (the sheet gives no peak current)' }
        : { value: sheet.peakCurrentA, basis: 'datasheet peak current' },
    continuousCurrentA:
      sheet.nominalCurrentA === undefined ? null : { value: sheet.nominalCurrentA, basis: 'datasheet nominal (continuous) current' },
    maxSpeedRpm: sheet.maxSpeedRpm === undefined ? null : sheet.maxSpeedRpm,
    windingMaxC: thermal === null ? null : thermal.maxWindingC,
  };
}

/** The fix text of each over-limit code. */
const FIX = {
  DRV_PEAK_OVER:
    'Choose a motor with a higher peak current, lower the demand (a slower profile, a lighter load) or change the gear ratio (ratioSweep).',
  DRV_RMS_OVER:
    'Choose a motor with a higher continuous current, a gear ratio nearer the inertia match (ratioSweep), or a gentler duty cycle.',
  DRV_SPEED_OVER: 'Raise the gear reduction or choose a motor rated for the shaft speed.',
  DRV_THERMAL_OVER:
    'The winding would exceed its limit at this duty: reduce the RMS torque, add cooling (a lower housing resistance) or choose a larger motor.',
  DRV_THERMAL_RUNAWAY:
    'The RMS current is above the runaway current: the copper loss heats the winding faster than the housing removes it. Reduce the RMS torque.',
  DRV_VOLTAGE_LIMITED:
    'The command was clipped by the current limit or the bus voltage: the motor cannot follow the profile as asked. Raise the supply, the current limit or the gear reduction.',
  DRV_MARGIN_LOW: 'The margin is under the requested one: leave more headroom (a larger motor or a better ratio).',
  DRV_TRACKING_ERROR:
    'The axis did not follow its profile: the effort is not the inverse dynamics. Raise the current limit or the bandwidth, or slow the profile.',
} as const;

/**
 * The sizing of `motor` for the run `run` (its drive data with the series): margins, thermal state, findings.
 * @invariant a factor without a datasheet value is listed in `notEvaluated`, never passed; margins are capacity / demand - 1
 */
export function sizingOf(motor: DcMotor, run: DriveRunData, ambientC: number, requestedMargin: number): SizingReport | null {
  const demand = demandOf(run);
  if (demand === null) return null;
  const capacity = capacityOf(motor);
  const thermal = thermalParams(motor.datasheet);
  const id = motor.id;
  const findings: SizingFinding[] = [];
  const notEvaluated: string[] = [];
  const margins: Partial<Record<Factor, number>> = {};
  const record = (factor: Factor, margin: number | null): void => {
    if (margin !== null) margins[factor] = margin;
  };

  record('peak_current', marginOf(capacity.peakCurrentA.value, demand.peakCurrentA));
  if (capacity.continuousCurrentA === null) notEvaluated.push('rms_current: the sheet gives no nominal current');
  else record('rms_current', marginOf(capacity.continuousCurrentA.value, demand.rmsCurrentA));
  if (capacity.maxSpeedRpm === null) notEvaluated.push('speed: the sheet gives no maximum speed');
  else record('speed', marginOf(capacity.maxSpeedRpm, demand.peakSpeedRpm));

  let thermalReport: ThermalReport | null = null;
  if (thermal === null) notEvaluated.push('thermal: the sheet gives no thermal data');
  else {
    const steady = steadyWindingC(thermal, demand.rmsCurrentA, ambientC);
    const runaway = steady === null;
    const series = run.series;
    const temperatures = series === undefined ? null : windingTemperatureSeries(thermal, series.times, series.currentA, ambientC);
    thermalReport = {
      steadyAtRmsC: steady,
      runaway,
      runawayCurrentA: runawayCurrent(thermal),
      maxContinuousCurrentA: continuousCurrentAtLimit(thermal, ambientC),
      peakWindingC: temperatures === null ? ambientC : Math.max(...temperatures.windingC),
      endWindingC: temperatures === null ? ambientC : (temperatures.windingC[temperatures.windingC.length - 1] ?? ambientC),
      timeConstantsS: { network: networkTimeConstants(thermal), datasheet: thermal.datasheetTaus },
    };
    // headroom of the winding rise: (limit - ambient) / (steady - ambient) - 1; the runaway is a fail on its own
    record('thermal', runaway ? -1 : marginOf(thermal.maxWindingC - ambientC, steady - ambientC));
  }

  const over = (factor: Factor, code: keyof typeof FIX, value: number, limit: number): void => {
    const margin = margins[factor];
    if (margin !== undefined && margin < 0) findings.push(finding(code, 'fail', [id], FIX[code], { value, limit }));
  };
  over('peak_current', 'DRV_PEAK_OVER', demand.peakCurrentA, capacity.peakCurrentA.value);
  if (capacity.continuousCurrentA !== null) over('rms_current', 'DRV_RMS_OVER', demand.rmsCurrentA, capacity.continuousCurrentA.value);
  if (capacity.maxSpeedRpm !== null) over('speed', 'DRV_SPEED_OVER', demand.peakSpeedRpm, capacity.maxSpeedRpm);
  if (thermalReport !== null && thermal !== null) {
    if (thermalReport.runaway)
      findings.push(
        finding('DRV_THERMAL_RUNAWAY', 'fail', [id], FIX.DRV_THERMAL_RUNAWAY, {
          value: demand.rmsCurrentA,
          limit: thermalReport.runawayCurrentA,
        }),
      );
    else if (thermalReport.steadyAtRmsC !== null && thermalReport.steadyAtRmsC > thermal.maxWindingC)
      findings.push(
        finding('DRV_THERMAL_OVER', 'fail', [id], FIX.DRV_THERMAL_OVER, { value: thermalReport.steadyAtRmsC, limit: thermal.maxWindingC }),
      );
    findings.push(
      finding(
        'DRV_THERMAL_MODEL_FORM',
        'info',
        [id],
        'The 2-node network built from the datasheet constants has its own time constants; the winding peak in a short run reads from the network, not the datasheet pair.',
        { value: thermalReport.timeConstantsS.network[0], limit: thermalReport.timeConstantsS.datasheet[1] },
      ),
    );
  }
  if (demand.limitedSamples > 0)
    findings.push(finding('DRV_VOLTAGE_LIMITED', 'warn', [id], FIX.DRV_VOLTAGE_LIMITED, { value: demand.limitedSamples }));
  if (run.tracking !== undefined && run.tracking.peakError > trackingLimit(run.tracking))
    findings.push(
      finding('DRV_TRACKING_ERROR', 'warn', [id], FIX.DRV_TRACKING_ERROR, {
        value: run.tracking.peakError,
        limit: trackingLimit(run.tracking),
      }),
    );
  if (!run.verified)
    findings.push(
      finding(
        'DRV_MOTOR_DATA_INCONSISTENT',
        'warn',
        [id],
        'The datasheet was accepted although it disagrees with itself: re-read it; the sizing is unverified.',
        { value: checkMotorData(motor.datasheet).maxGap },
      ),
    );

  const entries = Object.entries(margins) as [Factor, number][];
  const lowest = entries.length === 0 ? null : entries.reduce((a, b) => (b[1] < a[1] ? b : a));
  const limiting = lowest === null ? null : { factor: lowest[0], margin: lowest[1] };
  if (limiting !== null && limiting.margin >= 0 && limiting.margin < requestedMargin)
    findings.push(finding('DRV_MARGIN_LOW', 'warn', [id], FIX.DRV_MARGIN_LOW, { value: limiting.margin, limit: requestedMargin }));
  const failing = findings.some((entry) => entry.status === 'fail');
  const verdict = failing ? 'over' : limiting !== null && limiting.margin < requestedMargin ? 'marginal' : 'ok';
  return { demand, capacity, margins, limiting, thermal: thermalReport, findings, verdict, notEvaluated };
}
