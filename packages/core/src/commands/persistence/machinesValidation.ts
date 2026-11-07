/** Load-time validation of the PMSM, stepper and induction motor records of `dynamics.motors` (PHY-23 DRV-M4), same contract as `dcMotorProblem`. */

import { isRecord } from '../../lib/isRecord';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { isOptionalNonNegative, isOptionalPositive, isPositive, motorCommonProblem, thermalProblem } from './drivesValidation';

type Check = (record: Record<string, unknown>) => string | null;

const isPositiveInteger = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 1;

const requiredPositive = (sheet: Record<string, unknown>, keys: readonly string[]): string | null =>
  keys.every((key) => isPositive(sheet[key])) ? null : `datasheet needs positive ${keys.join(', ')}`;

const optionalPositive = (sheet: Record<string, unknown>, keys: readonly string[]): string | null =>
  keys.every((key) => isOptionalPositive(sheet[key])) ? null : `${keys.join(', ')} must be positive numbers when given`;

const PMSM_REQUIRED = ['phaseResistanceOhm', 'inductanceH', 'rotorInertiaKgM2', 'busVoltageV', 'peakCurrentA'] as const;
const PMSM_OPTIONAL = [
  'fluxLinkageWb',
  'torqueConstantNmPerA',
  'nominalCurrentA',
  'maxSpeedRpm',
  'peakTorqueNm',
  'noLoadSpeedRpm',
] as const;

/** Problem of a `kind: 'pmsm'` motor record, or null. */
export const pmsmMotorProblem: Check = (motor) => {
  const sheet = motor['datasheet'];
  if (!isRecord(sheet)) return 'pmsm motor needs a datasheet';
  if (!isPositiveInteger(sheet['polePairs'])) return 'pmsm datasheet polePairs must be a positive integer';
  if (sheet['fluxLinkageWb'] === undefined && sheet['torqueConstantNmPerA'] === undefined)
    return 'pmsm datasheet needs fluxLinkageWb or torqueConstantNmPerA';
  if (!isOptionalNonNegative(sheet['frictionNm'])) return 'pmsm datasheet frictionNm must be >= 0';
  return (
    requiredPositive(sheet, PMSM_REQUIRED) ?? optionalPositive(sheet, PMSM_OPTIONAL) ?? thermalProblem(sheet) ?? motorCommonProblem(motor)
  );
};

const STEPPER_REQUIRED = ['holdingTorqueNm', 'ratedCurrentA', 'phaseResistanceOhm', 'phaseInductanceH', 'rotorInertiaKgM2'] as const;
const STEPPER_OPTIONAL = ['stepAngleDeg', 'ratedVoltageV', 'maxSpeedRpm'] as const;

const isPullOutCurve = (value: unknown): boolean => {
  if (!Array.isArray(value) || value.length === 0) return false;
  let previous = -1;
  for (const point of value) {
    if (!Array.isArray(point) || point.length !== 2) return false;
    const [rpm, torque] = point;
    if (!isFiniteNumber(rpm) || !isFiniteNumber(torque) || rpm < 0 || torque < 0 || rpm <= previous) return false;
    previous = rpm;
  }
  return true;
};

/** Problem of a `kind: 'stepper'` motor record, or null. */
export const stepperMotorProblem: Check = (motor) => {
  const sheet = motor['datasheet'];
  if (!isRecord(sheet)) return 'stepper motor needs a datasheet';
  const steps = sheet['stepsPerRev'];
  if (!isPositiveInteger(steps) || (steps as number) % 4 !== 0) return 'stepper datasheet stepsPerRev must be a positive multiple of 4';
  if (!isOptionalNonNegative(sheet['detentTorqueNm']) || !isOptionalNonNegative(sheet['dampingNmsPerRad']))
    return 'stepper datasheet detentTorqueNm and dampingNmsPerRad must be >= 0';
  if (sheet['pullOutCurve'] !== undefined && !isPullOutCurve(sheet['pullOutCurve']))
    return 'stepper datasheet pullOutCurve must be [[rpm >= 0 strictly increasing, torque >= 0], ...]';
  return (
    requiredPositive(sheet, STEPPER_REQUIRED) ??
    optionalPositive(sheet, STEPPER_OPTIONAL) ??
    thermalProblem(sheet) ??
    motorCommonProblem(motor)
  );
};

const INDUCTION_REQUIRED = [
  'ratedVoltageV',
  'ratedFrequencyHz',
  'statorResistanceOhm',
  'rotorResistanceOhm',
  'magnetisingReactanceOhm',
  'rotorInertiaKgM2',
] as const;
const INDUCTION_OPTIONAL = [
  'ironLossResistanceOhm',
  'nominalCurrentA',
  'peakCurrentA',
  'maxSpeedRpm',
  'breakdownTorqueNm',
  'breakdownSlip',
  'startingTorqueNm',
] as const;

/** Problem of a `kind: 'induction'` motor record, or null. */
export const inductionMotorProblem: Check = (motor) => {
  const sheet = motor['datasheet'];
  if (!isRecord(sheet)) return 'induction motor needs a datasheet';
  if (!isPositiveInteger(sheet['polePairs'])) return 'induction datasheet polePairs must be a positive integer';
  const nonNegative = (key: string): boolean => isFiniteNumber(sheet[key]) && (sheet[key] as number) >= 0;
  if (!nonNegative('statorLeakageReactanceOhm') || !nonNegative('rotorLeakageReactanceOhm'))
    return 'induction datasheet needs statorLeakageReactanceOhm and rotorLeakageReactanceOhm >= 0';
  if (!isOptionalNonNegative(sheet['frictionNm'])) return 'induction datasheet frictionNm must be >= 0';
  return (
    requiredPositive(sheet, INDUCTION_REQUIRED) ??
    optionalPositive(sheet, INDUCTION_OPTIONAL) ??
    thermalProblem(sheet) ??
    motorCommonProblem(motor)
  );
};
