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
  joint['kind'] !== 'revolute' && joint['kind'] !== 'prismatic'
    ? "kind must be 'revolute' or 'prismatic'"
    : typeof joint['parent'] !== 'string' || typeof joint['child'] !== 'string'
      ? 'parent and child must be strings'
      : !isVec3(joint['anchor']) || !isVec3(joint['axis'])
        ? 'anchor and axis must be [x, y, z] finite numbers'
        : !isNonNegative(joint['damping']) || !isNonNegative(joint['friction']) || !isFiniteNumber(joint['initialVelocity'])
          ? 'damping, friction must be >= 0 and initialVelocity finite'
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
  for (const [table, check] of TABLES) {
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
  const children = Object.values(isRecord(value['joints']) ? value['joints'] : {}).flatMap((joint) =>
    isRecord(joint) && typeof joint['child'] === 'string' ? [joint['child']] : [],
  );
  for (const child of new Set(children.filter((id, i) => children.indexOf(id) !== i)))
    errors.push(`dynamics.joints: body '${child}' is the child of more than one joint`);
  return errors;
}
