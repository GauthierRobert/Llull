/** Load-time validation of the PHY-23 transmissions, joint physics and load schedules in `dynamics` (total: hostile records give a problem, never a throw). */

import { isRecord } from '../../lib/isRecord';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { dampingRatioForRestitution } from '../../lib/stopRestitution';

type Check = (record: Record<string, unknown>) => string | null;

const isPositive = (value: unknown): value is number => isFiniteNumber(value) && value > 0;
const isNonNegative = (value: unknown): value is number => isFiniteNumber(value) && value >= 0;
const isEfficiency = (value: unknown): boolean => isFiniteNumber(value) && value > 0 && value <= 1;
const optional = (value: unknown, check: (v: unknown) => boolean): boolean => value === undefined || check(value);
const isString = (value: unknown): value is string => typeof value === 'string';

function sourceProblem(source: unknown): string | null {
  return isRecord(source) && isString(source['name']) && ['A', 'B', 'C'].includes(String(source['grade']))
    ? null
    : 'source must be { name, grade: A | B | C }';
}

/** Optional source, losses and mesh numbers shared by the kinds that have them. */
function commonProblem(record: Record<string, unknown>): string | null {
  if (!optional(record['efficiency'], isEfficiency) || !optional(record['efficiencyBack'], isEfficiency))
    return 'efficiency and efficiencyBack must be in (0, 1]';
  if (!optional(record['meshStiffnessNmPerRad'], isPositive) || !optional(record['meshStiffnessNPerM'], isPositive))
    return 'mesh stiffness must be > 0';
  if (!optional(record['meshDampingRatio'], isPositive)) return 'meshDampingRatio must be > 0';
  return record['source'] === undefined ? null : sourceProblem(record['source']);
}

const jointsOf = (record: Record<string, unknown>, keys: readonly [string, string]): boolean => keys.every((key) => isString(record[key]));

/** Problem of a transmission record, or null. */
export const transmissionProblem: Check = (t) => {
  const common = commonProblem(t);
  if (common !== null) return common;
  switch (t['kind']) {
    case 'gear': {
      if (!jointsOf(t, ['driver', 'driven'])) return 'driver and driven must be joint ids';
      if (!isFiniteNumber(t['ratio']) || t['ratio'] === 0) return 'ratio must be a finite non-zero number';
      const teeth = t['teeth'];
      if (teeth !== undefined && !(Array.isArray(teeth) && teeth.length === 2 && teeth.every((n) => Number.isInteger(n) && n > 0)))
        return 'teeth must be [driver, driven] positive integers';
      return optional(t['backlashDeg'], isPositive) ? null : 'backlashDeg must be > 0';
    }
    case 'belt':
      if (!jointsOf(t, ['driver', 'driven'])) return 'driver and driven must be joint ids';
      return isPositive(t['driverDiameterMm']) && isPositive(t['drivenDiameterMm']) ? null : 'pulley diameters must be > 0';
    case 'lead_screw':
      if (!jointsOf(t, ['screw', 'nut'])) return 'screw and nut must be joint ids';
      if (!isPositive(t['leadMm']) || !isPositive(t['meanDiameterMm']) || !isNonNegative(t['mu']))
        return 'leadMm, meanDiameterMm > 0 and mu >= 0';
      return optional(t['flankAngleDeg'], (v) => isFiniteNumber(v) && v >= 0 && v < 90) ? null : 'flankAngleDeg must be in [0, 90)';
    case 'ball_screw':
      if (!jointsOf(t, ['screw', 'nut'])) return 'screw and nut must be joint ids';
      if (!isPositive(t['leadMm'])) return 'leadMm must be > 0';
      return isEfficiency(t['efficiency']) && isEfficiency(t['efficiencyBack'])
        ? null
        : 'a ball screw needs efficiency and efficiencyBack in (0, 1]';
    case 'rack_pinion':
      if (!jointsOf(t, ['pinion', 'rack'])) return 'pinion and rack must be joint ids';
      if (!isPositive(t['pitchRadiusMm'])) return 'pitchRadiusMm must be > 0';
      return optional(t['backlashMm'], isPositive) ? null : 'backlashMm must be > 0';
    default:
      return "kind must be 'gear', 'belt', 'lead_screw', 'ball_screw' or 'rack_pinion'";
  }
};

function frictionProblem(friction: unknown): string | null {
  if (!isRecord(friction)) return 'friction must be an object';
  if (!optional(friction['viscous'], isNonNegative)) return 'viscous must be >= 0';
  const source = sourceProblem(friction['source']);
  if (source !== null) return source;
  const [kinetic, fixed, coulomb] = [friction['kinetic'], friction['static'], friction['coulomb']];
  switch (friction['model']) {
    case 'coulomb':
      return isNonNegative(kinetic) ? null : 'coulomb needs kinetic >= 0';
    case 'stiction':
      return isNonNegative(kinetic) && isNonNegative(fixed) && fixed >= kinetic ? null : 'stiction needs static >= kinetic >= 0';
    case 'stribeck':
      return isNonNegative(coulomb) && isNonNegative(fixed) && fixed >= coulomb && isPositive(friction['stribeckVelocity'])
        ? null
        : 'stribeck needs static >= coulomb >= 0 and stribeckVelocity > 0';
    case 'load_dependent':
      return isNonNegative(friction['mu']) &&
        isPositive(friction['pinRadiusMm']) &&
        optional(friction['preloadN'], isNonNegative) &&
        optional(friction['frictionArmMm'], isPositive) &&
        optional(friction['base'], isNonNegative)
        ? null
        : 'load_dependent needs mu >= 0, pinRadiusMm > 0, preloadN / base >= 0, frictionArmMm > 0';
    default:
      return "friction.model must be 'coulomb', 'stiction', 'stribeck' or 'load_dependent'";
  }
}

/** Problem of a joint physics record, or null. */
export const jointPhysicsProblem: Check = (physics) => {
  const { limits, friction } = physics;
  if (limits !== undefined) {
    if (!isRecord(limits) || !isFiniteNumber(limits['min']) || !isFiniteNumber(limits['max']) || !(limits['min'] < limits['max']))
      return 'limits need finite min < max';
    if (!isPositive(limits['stiffness']) || !optional(limits['dampingRatio'], isPositive))
      return 'limits.stiffness and dampingRatio must be > 0';
    if (!optional(limits['restitution'], (v) => isFiniteNumber(v) && v > 0 && v <= 1 && dampingRatioForRestitution(v) !== null))
      return 'limits.restitution must be reachable by a one-sided stop (0.0002 < e <= 1)';
  }
  if (friction !== undefined) {
    const problem = frictionProblem(friction);
    if (problem !== null) return problem;
  }
  return optional(physics['armatureKgM2'], isNonNegative) ? null : 'armatureKgM2 must be >= 0';
};

/** Problem of a load schedule record, or null. */
export const loadScheduleProblem: Check = (load) => {
  const target = load['target'];
  if (!isRecord(target) || isString(target['body']) === isString(target['joint'])) return 'target must be { body } or { joint }';
  if (load['kind'] !== 'force' && load['kind'] !== 'torque') return "kind must be 'force' or 'torque'";
  const direction = load['direction'];
  if (direction !== undefined && !(Array.isArray(direction) && direction.length === 3 && direction.every(isFiniteNumber)))
    return 'direction must be [x, y, z] finite numbers';
  if (load['profile'] !== undefined && !isString(load['profile'])) return 'profile must be a profile id';
  if (load['constant'] !== undefined && !isFiniteNumber(load['constant'])) return 'constant must be finite';
  return load['profile'] === undefined && load['constant'] === undefined ? 'a load needs a profile or a constant' : null;
};

const table = (dynamics: Record<string, unknown>, key: string): Record<string, unknown> =>
  isRecord(dynamics[key]) ? (dynamics[key] as Record<string, unknown>) : {};
const kindOf = (joints: Record<string, unknown>, id: string): string | undefined => {
  const joint = Object.hasOwn(joints, id) ? joints[id] : undefined;
  return isRecord(joint) && isString(joint['kind']) ? joint['kind'] : undefined;
};
const endsOf = (t: Record<string, unknown>): string[] =>
  ['driver', 'driven', 'screw', 'nut', 'pinion', 'rack'].flatMap((key) => (isString(t[key]) ? [t[key]] : []));

/** Cross references: transmissions use existing joints and drive a joint once, joint physics sit on joints, loads name bodies / joints / profiles. */
export function transmissionReferenceProblems(dynamics: Record<string, unknown>): string[] {
  const [known, bodies, profiles] = [table(dynamics, 'joints'), table(dynamics, 'bodies'), table(dynamics, 'profiles')];
  const problems: string[] = [];
  const driven = new Set<string>();
  for (const [id, t] of Object.entries(table(dynamics, 'transmissions'))) {
    if (!isRecord(t)) continue;
    const ends = endsOf(t);
    for (const joint of ends)
      if (!Object.hasOwn(known, joint)) problems.push(`dynamics.transmissions['${id}']: joint '${joint}' does not exist`);
    const target = ends[1];
    if (target !== undefined && driven.has(target)) problems.push(`dynamics.transmissions['${id}']: joint '${target}' is already driven`);
    if (target !== undefined) driven.add(target);
    const [kindOfDriver, kindOfDriven] = ends.map((joint) => kindOf(known, joint));
    const linear = t['kind'] !== 'gear' && t['kind'] !== 'belt';
    if (
      (kindOfDriver !== undefined && kindOfDriver !== 'revolute') ||
      (kindOfDriven !== undefined && kindOfDriven !== (linear ? 'prismatic' : 'revolute'))
    )
      problems.push(
        `dynamics.transmissions['${id}']: a ${String(t['kind'])} couples a revolute driver with a ${linear ? 'prismatic' : 'revolute'} joint`,
      );
  }
  const driverOf = new Map<string, string>();
  for (const t of Object.values(table(dynamics, 'transmissions'))) {
    const ends = isRecord(t) ? endsOf(t) : [];
    if (ends.length >= 2 && ends[0] !== undefined && ends[1] !== undefined) driverOf.set(ends[1], ends[0]);
  }
  for (const start of driverOf.keys()) {
    const seen = new Set<string>([start]);
    for (let current = driverOf.get(start); current !== undefined; current = driverOf.get(current)) {
      if (seen.has(current)) {
        if (current === start) problems.push(`dynamics.transmissions: joint '${start}' drives itself through a circle of transmissions`);
        break;
      }
      seen.add(current);
    }
  }
  for (const id of Object.keys(table(dynamics, 'jointPhysics'))) {
    if (!Object.hasOwn(known, id)) problems.push(`dynamics.jointPhysics['${id}']: no joint '${id}'`);
    else if (kindOf(known, id) === 'spherical') problems.push(`dynamics.jointPhysics['${id}']: a spherical joint has no coordinate`);
  }
  for (const [id, load] of Object.entries(table(dynamics, 'loadSchedules'))) {
    if (!isRecord(load) || !isRecord(load['target'])) continue;
    const { body, joint } = load['target'];
    if (isString(body) && !Object.hasOwn(bodies, body)) problems.push(`dynamics.loadSchedules['${id}']: no body '${body}'`);
    if (isString(joint) && !Object.hasOwn(known, joint)) problems.push(`dynamics.loadSchedules['${id}']: no joint '${joint}'`);
    const jointKind = isString(joint) ? kindOf(known, joint) : undefined;
    if (jointKind !== undefined && (jointKind === 'spherical' || (jointKind === 'revolute') !== (load['kind'] === 'torque')))
      problems.push(`dynamics.loadSchedules['${id}']: a ${String(load['kind'])} does not fit the ${jointKind} joint '${String(joint)}'`);
    if (isString(load['profile']) && !Object.hasOwn(profiles, load['profile']))
      problems.push(`dynamics.loadSchedules['${id}']: profile '${load['profile']}' does not exist`);
  }
  return problems;
}
