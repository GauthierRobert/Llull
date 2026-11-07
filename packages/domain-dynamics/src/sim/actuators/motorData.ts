/**
 * Datasheet consistency of a datasheet motor. DC (PHY-23 TR-DRV-04): the redundant numbers of a motor sheet must agree with the ones derived from
 * R, kt and U. relative gap = (derived - given) / given; pass when |gap| <= 2 %. A check whose datasheet value is absent is `notGiven`.
 */

import type { DatasheetMotor, DcMotorDatasheet, InductionMotor, PmsmMotor, StepperMotor } from '@core/model/drives';
import { inductionCircuit, inductionParameters } from './induction';
import { phaseVoltageLimit, pmsmParameters } from './pmsm';

export const DATA_TOLERANCE = 0.02;

const RPM_PER_RAD_PER_S = 60 / (2 * Math.PI);

interface DataCheck {
  readonly quantity: string;
  readonly derived: number;
  readonly datasheet: number | null;
  readonly relativeGap: number | null;
  readonly status: 'pass' | 'fail' | 'notGiven';
}

export interface MotorDataResult {
  readonly checks: readonly DataCheck[];
  /** Largest |relative gap| over the checks that could be made (0 when none). */
  readonly maxGap: number;
  readonly consistent: boolean;
  readonly notGiven: readonly string[];
}

/** The six checks of TR-DRV-04 on a datasheet. */
export function checkMotorData(sheet: DcMotorDatasheet): MotorDataResult {
  const { nominalVoltageV: u, terminalResistanceOhm: r, torqueConstantNmPerA: kt } = sheet;
  const stallCurrent = u / r;
  const stallTorque = kt * stallCurrent;
  const noLoadCurrent = sheet.noLoadCurrentA === undefined ? 0 : sheet.noLoadCurrentA;
  const noLoadSpeed = ((u - r * noLoadCurrent) / kt) * RPM_PER_RAD_PER_S;
  const entries: readonly Entry[] = [
    ['stallCurrentA', stallCurrent, sheet.stallCurrentA],
    ['stallTorqueNm', stallTorque, sheet.stallTorqueNm],
    [
      'keFromSpeedConstantVsPerRad',
      sheet.speedConstantRpmPerV === undefined ? 0 : 1 / (sheet.speedConstantRpmPerV / RPM_PER_RAD_PER_S),
      sheet.speedConstantRpmPerV === undefined ? undefined : kt,
    ],
    ['noLoadSpeedRpm', noLoadSpeed, sheet.noLoadSpeedRpm],
    ['mechanicalTimeConstantS', (sheet.rotorInertiaKgM2 * r) / (kt * kt), sheet.mechanicalTimeConstantS],
    ['speedTorqueGradientRpmPerMNm', noLoadSpeed / (stallTorque * 1000), sheet.speedTorqueGradientRpmPerMNm],
  ];
  return resultOf(entries);
}

type Entry = readonly [quantity: string, derived: number, given: number | undefined];

function resultOf(entries: readonly Entry[]): MotorDataResult {
  const checks: DataCheck[] = entries.map(([quantity, derived, given]) => {
    if (given === undefined) return { quantity, derived, datasheet: null, relativeGap: null, status: 'notGiven' };
    const gap = (derived - given) / given;
    return { quantity, derived, datasheet: given, relativeGap: gap, status: Math.abs(gap) <= DATA_TOLERANCE ? 'pass' : 'fail' };
  });
  const gaps = checks.flatMap((check) => (check.relativeGap === null ? [] : [Math.abs(check.relativeGap)]));
  return {
    checks,
    maxGap: Math.max(0, ...gaps),
    consistent: checks.every((check) => check.status !== 'fail'),
    notGiven: checks.filter((check) => check.status === 'notGiven').map((check) => check.quantity),
  };
}

/** PMSM: kt against 1.5·p·λ (when both are given), the peak torque kt·I_max, the ideal no-load speed V_max / (p·λ). */
function checkPmsm(motor: PmsmMotor): MotorDataResult {
  const sheet = motor.datasheet;
  const p = pmsmParameters(motor);
  return resultOf([
    [
      'torqueConstantNmPerA',
      sheet.fluxLinkageWb === undefined ? 0 : 1.5 * sheet.polePairs * sheet.fluxLinkageWb,
      sheet.fluxLinkageWb === undefined ? undefined : sheet.torqueConstantNmPerA,
    ],
    ['peakTorqueNm', p.torqueConstant * sheet.peakCurrentA, sheet.peakTorqueNm],
    [
      'noLoadSpeedRpm',
      (phaseVoltageLimit(sheet.busVoltageV) / (sheet.polePairs * p.fluxLinkageWb)) * RPM_PER_RAD_PER_S,
      sheet.noLoadSpeedRpm,
    ],
  ]);
}

/** Stepper: the step angle 360 / steps and the rated voltage R·I (a plain resistive limit, no chopper). */
function checkStepper(motor: StepperMotor): MotorDataResult {
  const sheet = motor.datasheet;
  return resultOf([
    ['stepAngleDeg', 360 / sheet.stepsPerRev, sheet.stepAngleDeg],
    ['ratedVoltageV', sheet.phaseResistanceOhm * sheet.ratedCurrentA, sheet.ratedVoltageV],
  ]);
}

/** Induction: breakdown torque / slip and the starting torque of the equivalent circuit at the rated voltage and frequency. */
function checkInduction(motor: InductionMotor): MotorDataResult {
  const sheet = motor.datasheet;
  const circuit = inductionCircuit(inductionParameters(motor), sheet.ratedVoltageV, sheet.ratedFrequencyHz);
  return resultOf([
    ['breakdownTorqueNm', circuit.breakdownTorqueNm, sheet.breakdownTorqueNm],
    ['breakdownSlip', circuit.breakdownSlip, sheet.breakdownSlip],
    ['startingTorqueNm', circuit.startingTorqueNm, sheet.startingTorqueNm],
  ]);
}

/** The consistency checks of a datasheet motor of any kind. */
export function checkDatasheet(motor: DatasheetMotor): MotorDataResult {
  switch (motor.kind) {
    case 'dc':
      return checkMotorData(motor.datasheet);
    case 'pmsm':
      return checkPmsm(motor);
    case 'stepper':
      return checkStepper(motor);
    case 'induction':
      return checkInduction(motor);
  }
}
