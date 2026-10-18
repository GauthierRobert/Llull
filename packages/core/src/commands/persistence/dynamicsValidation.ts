/** Load-time validation of the optional `dynamics` field (rigid bodies, joints, gears, motors, propellers). */

import { isRecord } from '../../lib/isRecord';
import { isStringArray } from '../../lib/isStringArray';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { isReservedKey } from '../../lib/reservedKey';

const isVec3 = (value: unknown): boolean => Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
const isNonNegative = (value: unknown): boolean => isFiniteNumber(value) && value >= 0;
const isPositive = (value: unknown): boolean => isFiniteNumber(value) && value > 0;
const isOptional = (value: unknown, check: (v: unknown) => boolean): boolean => value === undefined || check(value);

type Check = (record: Record<string, unknown>) => string | null;

const bodyProblem: Check = (body) =>
  !isStringArray(body['entityIds']) || body['entityIds'].length === 0
    ? 'entityIds must be a non-empty string array'
    : typeof body['fixed'] !== 'boolean'
      ? 'fixed must be a boolean'
      : !isOptional(body['density'], isPositive) || !isOptional(body['massKg'], isPositive)
        ? 'density / massKg must be positive numbers'
        : null;

const jointProblem: Check = (joint) =>
  joint['kind'] !== 'revolute' && joint['kind'] !== 'prismatic' && joint['kind'] !== 'spherical'
    ? "kind must be 'revolute', 'prismatic' or 'spherical'"
    : typeof joint['parent'] !== 'string' || typeof joint['child'] !== 'string'
      ? 'parent and child must be strings'
      : !isVec3(joint['anchor']) || !isVec3(joint['axis']) || !isOptional(joint['anchorOnChild'], isVec3)
        ? 'anchor, axis and anchorOnChild must be [x, y, z] finite numbers'
        : !isNonNegative(joint['damping']) || !isNonNegative(joint['friction']) || !isFiniteNumber(joint['initialVelocity'])
          ? 'damping, friction must be >= 0 and initialVelocity finite'
          : !isOptional(joint['stiffness'], isNonNegative) || !isOptional(joint['springReference'], isFiniteNumber)
            ? 'stiffness must be >= 0 and springReference finite'
            : joint['kind'] === 'spherical' &&
                (joint['damping'] !== 0 || joint['friction'] !== 0 || joint['initialVelocity'] !== 0 || joint['stiffness'] !== undefined)
              ? 'a spherical joint has damping = friction = initialVelocity = 0 and no spring'
              : null;

const gearProblem: Check = (gear) =>
  typeof gear['driver'] !== 'string' || typeof gear['driven'] !== 'string'
    ? 'driver and driven must be joint ids'
    : !isFiniteNumber(gear['ratio']) || gear['ratio'] === 0
      ? 'ratio must be a finite non-zero number'
      : null;

const isCurve = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((point) => Array.isArray(point) && point.length === 2 && point.every(isFiniteNumber));

const motorProblem: Check = (motor) => {
  if (typeof motor['joint'] !== 'string') return 'joint must be a string';
  if (motor['kind'] === 'torque_curve')
    return isCurve(motor['curve']) && isFiniteNumber(motor['throttle']) ? null : 'torque_curve needs curve [[rpm, N·m], …] and throttle';
  if (motor['kind'] === 'speed')
    return isFiniteNumber(motor['rpm']) && isPositive(motor['maxTorque']) ? null : 'speed needs rpm and maxTorque > 0';
  return "kind must be 'torque_curve' or 'speed'";
};

const propellerProblem: Check = (propeller) =>
  typeof propeller['joint'] !== 'string'
    ? 'joint must be a string'
    : !isPositive(propeller['diameter']) || !isPositive(propeller['airDensity'])
      ? 'diameter and airDensity must be positive'
      : !isNonNegative(propeller['thrustCoefficient']) || !isNonNegative(propeller['powerCoefficient'])
        ? 'thrust / power coefficients must be >= 0'
        : !isVec3(propeller['thrustDirection'])
          ? 'thrustDirection must be [x, y, z]'
          : null;

const isPoints = (value: unknown, minimum: number): boolean =>
  Array.isArray(value) &&
  value.length >= minimum &&
  value.every((point) => Array.isArray(point) && point.length === 2 && point.every(isFiniteNumber));

const allFinite = (record: Record<string, unknown>, keys: readonly string[]): boolean => keys.every((key) => isFiniteNumber(record[key]));

const isGreaterThanMinusOne = (value: unknown): boolean => isFiniteNumber(value) && value > -1;

const wiebeProblem = (model: Record<string, unknown>): string | null => {
  const heat = model['heat'];
  if (!isRecord(heat) || (heat['kind'] !== 'per_cycle_J' && heat['kind'] !== 'target_imep_Pa') || !isFiniteNumber(heat['value']))
    return 'wiebe needs heat { kind: per_cycle_J | target_imep_Pa, value }';
  const keys = ['startDeg', 'durationDeg', 'a', 'm', 'compressionIndex', 'expansionIndex', 'intakePressurePa'];
  return allFinite(model, keys) && isPositive(model['durationDeg']) && isPositive(model['a']) && isGreaterThanMinusOne(model['m'])
    ? null
    : 'wiebe needs finite startDeg, durationDeg > 0, a > 0, m > -1, compressionIndex, expansionIndex, intakePressurePa';
};

const singleZoneProblem = (model: Record<string, unknown>): string | null => {
  const [burn, woschni, heat] = [model['burn'], model['woschni'], model['heat']];
  if (
    !isRecord(burn) ||
    !isPositive(burn['durationDeg']) ||
    !isPositive(burn['a']) ||
    !allFinite(burn, ['rpmExponent']) ||
    !isGreaterThanMinusOne(burn['m'])
  )
    return 'single_zone burn needs durationDeg > 0, a > 0, m > -1, rpmExponent and ca50Deg or startDeg';
  if (!isFiniteNumber(burn['ca50Deg']) && !isFiniteNumber(burn['startDeg'])) return 'single_zone burn needs ca50Deg or startDeg';
  if (
    !isRecord(woschni) ||
    !allFinite(woschni, ['c3', 'tempExponent']) ||
    !['c1', 'c2Closed', 'c2Exchange', 'wallTempK'].every((key) => isPositive(woschni[key])) ||
    !isNonNegative(woschni['c3'])
  )
    return 'single_zone woschni needs c1, c2Closed, c2Exchange, wallTempK > 0 and c3 >= 0, tempExponent';
  if (!isPositive(model['intakePressurePa']) || !isPositive(model['intakeTempK']))
    return 'single_zone needs intakePressurePa and intakeTempK > 0';
  const heatOk =
    isRecord(heat) &&
    (heat['kind'] === 'per_cycle_J' ? isPositive(heat['value']) : heat['kind'] === 'table_vs_rpm' && isPoints(heat['points'], 1));
  return heatOk ? null : 'single_zone heat must be per_cycle_J { value > 0 } or table_vs_rpm { points }';
};

const cylinderProblem: Check = (cylinder) => {
  if (typeof cylinder['piston'] !== 'string' || typeof cylinder['crank'] !== 'string') return 'piston and crank must be joint ids';
  const ratio = cylinder['compressionRatio'];
  if (!isPositive(cylinder['boreMm']) || !isFiniteNumber(ratio) || ratio <= 1) return 'boreMm must be > 0 and compressionRatio > 1';
  if (cylinder['cycle'] !== 'four_stroke' && cylinder['cycle'] !== 'two_stroke') return "cycle must be 'four_stroke' or 'two_stroke'";
  if (!isFiniteNumber(cylinder['firingOffsetDeg']) || !isPositive(cylinder['ambientPressurePa']))
    return 'firingOffsetDeg finite, ambientPressurePa > 0';
  if (cylinder['tdcCrankAngleRad'] !== null && !isFiniteNumber(cylinder['tdcCrankAngleRad']))
    return 'tdcCrankAngleRad must be a number or null';
  const model = cylinder['model'];
  if (!isRecord(model)) return 'model must be an object';
  if (model['kind'] === 'table') return isPoints(model['points'], 2) ? null : 'table needs points [[cycleDeg, gaugePa], ...] (at least 2)';
  if (model['kind'] === 'wiebe') return wiebeProblem(model);
  if (model['kind'] === 'single_zone') return singleZoneProblem(model);
  return "model.kind must be 'table', 'wiebe' or 'single_zone'";
};

const springProblem: Check = (spring) =>
  typeof spring['bodyA'] !== 'string' || typeof spring['bodyB'] !== 'string' || spring['bodyA'] === spring['bodyB']
    ? 'bodyA and bodyB must be two different body ids (or ground)'
    : !isVec3(spring['pointA']) || !isVec3(spring['pointB'])
      ? 'pointA and pointB must be [x, y, z] finite numbers'
      : !isPositive(spring['stiffness']) || !isNonNegative(spring['damping']) || !isNonNegative(spring['freeLengthM'])
        ? 'stiffness must be > 0, damping and freeLengthM >= 0'
        : null;

const solverProblem = (solver: unknown): string | null => {
  if (solver === undefined) return null;
  if (!isRecord(solver)) return 'solver must be an object';
  const step = solver['timestepS'];
  const stepOk = step === 'auto' || (isFiniteNumber(step) && step >= 1e-5 && step <= 0.01);
  if (!stepOk || (solver['integrator'] !== 'rk4' && solver['integrator'] !== 'implicitfast'))
    return "timestepS must be 'auto' or in 1e-5..0.01 s; integrator 'rk4' | 'implicitfast'";
  const [steps, impedance] = [solver['loopTimeConstantSteps'], solver['loopImpedance']];
  if (!isFiniteNumber(steps) || steps < 2 || steps > 1000) return 'loopTimeConstantSteps must be in 2..1000';
  if (!isFiniteNumber(impedance) || impedance <= 0 || impedance > 0.9999) return 'loopImpedance must be in (0, 0.9999]';
  const [pass, fail] = [solver['loopResidualPassM'], solver['loopResidualFailM']];
  if (!isPositive(pass) || !isPositive(fail) || !isPositive(solver['timestepSensitivityGate']))
    return 'loopResidualPassM, loopResidualFailM, timestepSensitivityGate must be > 0';
  return (pass as number) <= (fail as number) ? null : 'loopResidualPassM must not exceed loopResidualFailM';
};

const TABLES: ReadonlyArray<readonly [string, Check]> = [
  ['bodies', bodyProblem],
  ['joints', jointProblem],
  ['gears', gearProblem],
  ['motors', motorProblem],
  ['propellers', propellerProblem],
];

/** Problems of the optional `dynamics` field of a raw document (absent is valid). */
export function dynamicsProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value) || !isVec3(value['gravity']))
    return ['dynamics must be { gravity: [x, y, z], bodies, joints, gears, motors, propellers }'];
  const errors: string[] = [];
  const solverError = solverProblem(value['solver']);
  if (solverError !== null) errors.push(`dynamics.solver: ${solverError}`);
  const tables = [
    ...TABLES,
    ...(value['cylinders'] === undefined ? [] : [['cylinders', cylinderProblem] as const]),
    ...(value['springs'] === undefined ? [] : [['springs', springProblem] as const]),
  ];
  for (const [table, check] of tables) {
    const records = value[table];
    if (!isRecord(records)) {
      errors.push(`dynamics.${table} must be an object`);
      continue;
    }
    for (const [id, record] of Object.entries(records)) {
      if (isReservedKey(id)) errors.push(`dynamics.${table}: id '${id}' is a reserved JavaScript property name`);
      else if (!isRecord(record) || record['id'] !== id) errors.push(`dynamics.${table}['${id}'] must be an object whose id is '${id}'`);
      else {
        const problem = check(record);
        if (problem !== null) errors.push(`dynamics.${table}['${id}']: ${problem}`);
      }
    }
  }
  return errors;
}
