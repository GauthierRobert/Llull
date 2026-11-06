/** Load-time validation of the PHY-23 drive data in `dynamics`: datasheet motors, motion profiles and motor drives. */

import { isRecord } from '../../lib/isRecord';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { compileProfile, isProfileRefusal, profileUnitScale } from '../../geometry/motionProfile';
import type { MotionProfile, ProfileQuantity } from '../../model/drives';

type Check = (record: Record<string, unknown>) => string | null;

const isPositive = (value: unknown): boolean => isFiniteNumber(value) && value > 0;
const isOptionalPositive = (value: unknown): boolean => value === undefined || isPositive(value);
const isOptionalNonNegative = (value: unknown): boolean => value === undefined || (isFiniteNumber(value) && value >= 0);

const SHEET_REQUIRED = ['nominalVoltageV', 'terminalResistanceOhm', 'torqueConstantNmPerA', 'rotorInertiaKgM2'] as const;
const SHEET_OPTIONAL_POSITIVE = [
  'nominalCurrentA',
  'stallTorqueNm',
  'stallCurrentA',
  'noLoadSpeedRpm',
  'speedConstantRpmPerV',
  'speedTorqueGradientRpmPerMNm',
  'mechanicalTimeConstantS',
  'maxSpeedRpm',
  'peakCurrentA',
] as const;

function sourceProblem(source: unknown): string | null {
  return isRecord(source) && typeof source['name'] === 'string' && ['A', 'B', 'C'].includes(String(source['grade']))
    ? null
    : 'source must be { name, grade: A | B | C }';
}

/** Problem of a `kind: 'dc'` motor record (the common `joint` is checked by the caller), or null. */
export const dcMotorProblem: Check = (motor) => {
  const sheet = motor['datasheet'];
  if (!isRecord(sheet) || !SHEET_REQUIRED.every((key) => isPositive(sheet[key])))
    return `dc motor datasheet needs positive ${SHEET_REQUIRED.join(', ')}`;
  if (!isOptionalNonNegative(sheet['terminalInductanceH']) || !isOptionalNonNegative(sheet['noLoadCurrentA']))
    return 'datasheet terminalInductanceH and noLoadCurrentA must be >= 0';
  if (!SHEET_OPTIONAL_POSITIVE.every((key) => isOptionalPositive(sheet[key]))) return 'optional datasheet values must be positive numbers';
  const gearhead = motor['gearhead'];
  if (gearhead !== undefined) {
    if (!isRecord(gearhead) || !isPositive(gearhead['ratio'])) return 'gearhead.ratio must be > 0';
    const efficient = (value: unknown): boolean => isFiniteNumber(value) && value > 0 && value <= 1;
    if (!efficient(gearhead['efficiency']) || (gearhead['efficiencyBack'] !== undefined && !efficient(gearhead['efficiencyBack'])))
      return 'gearhead efficiencies must be in (0, 1]';
    if (!isOptionalNonNegative(gearhead['inertiaKgM2'])) return 'gearhead.inertiaKgM2 must be >= 0';
  }
  if (motor['acceptInconsistent'] !== undefined && typeof motor['acceptInconsistent'] !== 'string')
    return 'acceptInconsistent must be a string';
  return sourceProblem(motor['source']);
};

const MAX_SEGMENTS = 10000;
const QUANTITIES: readonly string[] = ['position', 'velocity', 'torque', 'force', 'voltage', 'frequency'];

/** Problem of a motion profile record: shape, then the same compile step `add_motion_profile` ran. */
export const profileProblem: Check = (profile) => {
  if (typeof profile['quantity'] !== 'string' || !QUANTITIES.includes(profile['quantity']) || typeof profile['unit'] !== 'string')
    return 'quantity must be position | velocity | torque | force | voltage | frequency and unit a string';
  if (profileUnitScale(profile['quantity'] as ProfileQuantity, profile['unit']) === null)
    return `unit '${profile['unit']}' is not a ${profile['quantity']} unit`;
  if (Array.isArray(profile['segments']) && profile['segments'].length > MAX_SEGMENTS) return `at most ${MAX_SEGMENTS} segments`;
  if (
    !Array.isArray(profile['segments']) ||
    profile['segments'].some((segment) => !isRecord(segment) || typeof segment['kind'] !== 'string')
  )
    return 'segments must be an array of { kind, ... } objects';
  const compiled = compileProfile(profile as unknown as MotionProfile);
  return isProfileRefusal(compiled) ? `${compiled.code}: ${compiled.error}` : null;
};

/** Cross references of drives (a drive belongs to a datasheet motor and names a stored profile), as problems with their paths. */
export function driveReferenceProblems(dynamics: Record<string, unknown>): string[] {
  const [drives, motors, profiles] = [dynamics['drives'], dynamics['motors'], dynamics['profiles']];
  if (!isRecord(drives) || !isRecord(motors)) return [];
  return Object.entries(drives).flatMap(([id, drive]): string[] => {
    const motor = motors[id];
    if (!isRecord(motor) || motor['kind'] !== 'dc') return [`dynamics.drives['${id}']: no datasheet (dc) motor '${id}'`];
    const profile = isRecord(drive) ? drive['profile'] : undefined;
    if (typeof profile === 'string' && !(isRecord(profiles) && isRecord(profiles[profile])))
      return [`dynamics.drives['${id}']: profile '${profile}' does not exist`];
    return [];
  });
}

const MODES: readonly string[] = ['voltage', 'torque', 'velocity', 'position', 'prescribed'];

/** Problem of a motor drive record, or null. */
export const driveProblem: Check = (drive) => {
  if (typeof drive['mode'] !== 'string' || !MODES.includes(drive['mode'])) return `mode must be one of ${MODES.join(', ')}`;
  if (drive['profile'] !== undefined && typeof drive['profile'] !== 'string') return 'profile must be a profile id';
  if (drive['volts'] !== undefined && !isFiniteNumber(drive['volts'])) return 'volts must be finite';
  if (!['currentLimitA', 'busVoltageV', 'sampleHz', 'effortLimit'].every((key) => isOptionalPositive(drive[key])))
    return 'limits and sampleHz must be positive numbers';
  const gains = drive['gains'];
  if (gains !== undefined && (!isRecord(gains) || !isFiniteNumber(gains['kp']))) return 'gains must be { kp, ki?, kpPosition? }';
  const tune = drive['tune'];
  if (tune !== undefined && (!isRecord(tune) || !isPositive(tune['bandwidthHz']) || !isPositive(tune['dampingRatio'])))
    return 'tune must be { bandwidthHz > 0, dampingRatio > 0 }';
  return null;
};
