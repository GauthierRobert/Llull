/** Load-time validation of transmissions, joint physics and load schedules (DRV-M2): every hostile record names a path; valid data round-trips. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { dynamicsProblems } from '@core/commands/persistence/dynamicsValidation';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument } from '@core/model/types';
import { DYNAMICS_SEED } from '../../helpers/pluginSliceSeeds';

const raw = (): Record<string, unknown> => {
  const saved = JSON.parse(serializeDocument(DYNAMICS_SEED.build())) as { document: { dynamics: Record<string, unknown> } };
  return saved.document.dynamics;
};
type Table = Record<string, Record<string, unknown>>;
const problemsAfter = (change: (dynamics: Record<string, unknown>) => void): string[] => {
  const dynamics = raw();
  change(dynamics);
  return dynamicsProblems(dynamics);
};
const table = (dynamics: Record<string, unknown>, name: string): Table => dynamics[name] as Table;

describe('dynamics transmissions, joint physics and load schedules survive a save and a load', () => {
  it('the seed (gear with backlash, lead screw, Stribeck + stops + armature, torque load) is valid and round-trips byte for byte', () => {
    expect(dynamicsProblems(raw())).toEqual([]);
    const document = DYNAMICS_SEED.build();
    const saved = serializeDocument(document);
    expect(serializeDocument(deserializeDocument(saved))).toBe(saved);
    expect(execute(createEmptyDocument(), 'load_document', { json: saved }).summary).toMatch(/^Loaded document/);
  });

  it('names the path of each malformed record', () => {
    const bad = (label: string, change: (dynamics: Record<string, unknown>) => void, expected: RegExp): void => {
      const problems = problemsAfter(change);
      expect(problems.length, label).toBeGreaterThan(0);
      expect(problems.join(' | '), label).toMatch(expected);
    };
    const gear = (dynamics: Record<string, unknown>): Record<string, unknown> => table(dynamics, 'transmissions')['tg'] ?? {};
    const screw = (dynamics: Record<string, unknown>): Record<string, unknown> => table(dynamics, 'transmissions')['ts'] ?? {};
    const physics = (dynamics: Record<string, unknown>): Record<string, unknown> => table(dynamics, 'jointPhysics')['j2'] ?? {};
    const load = (dynamics: Record<string, unknown>): Record<string, unknown> => table(dynamics, 'loadSchedules')['ls'] ?? {};
    bad('kind', (d) => void (gear(d)['kind'] = 'foo'), /transmissions\['tg'\]: kind must be/);
    bad('ratio', (d) => void (gear(d)['ratio'] = 0), /transmissions\['tg'\]: ratio/);
    bad('efficiency', (d) => void (gear(d)['efficiency'] = 2), /efficiency and efficiencyBack/);
    bad('teeth', (d) => void (gear(d)['teeth'] = ['a', 'b']), /teeth must be/);
    bad('backlash', (d) => void (gear(d)['backlashDeg'] = -1), /backlashDeg/);
    bad('mesh stiffness', (d) => void (gear(d)['meshStiffnessNmPerRad'] = 0), /mesh stiffness/);
    bad('mesh damping', (d) => void (gear(d)['meshDampingRatio'] = -1), /meshDampingRatio/);
    bad('source', (d) => void (gear(d)['source'] = { name: 1, grade: 'A' }), /source must be/);
    bad('driver', (d) => void (gear(d)['driver'] = 7), /driver and driven/);
    bad('ghost joint', (d) => void (gear(d)['driven'] = 'ghost'), /joint 'ghost' does not exist/);
    bad('driven twice', (d) => void (gear(d)['driven'] = 'jn'), /already driven/);
    bad('screw lead', (d) => void (screw(d)['leadMm'] = 0), /leadMm, meanDiameterMm > 0/);
    bad('screw flank', (d) => void (screw(d)['flankAngleDeg'] = 90), /flankAngleDeg/);
    bad(
      'belt',
      (d) =>
        void (table(d, 'transmissions')['bt'] = {
          kind: 'belt',
          id: 'bt',
          driver: 'j',
          driven: 'j2',
          driverDiameterMm: 0,
          drivenDiameterMm: 1,
        }),
      /pulley diameters/,
    );
    bad(
      'ball screw',
      (d) => void (table(d, 'transmissions')['bs'] = { kind: 'ball_screw', id: 'bs', screw: 'j', nut: 'jn', leadMm: 5, efficiency: 0.9 }),
      /ball screw needs/,
    );
    bad(
      'rack',
      (d) => void (table(d, 'transmissions')['rp'] = { kind: 'rack_pinion', id: 'rp', pinion: 'j', rack: 'jn', pitchRadiusMm: -1 }),
      /pitchRadiusMm/,
    );
    bad('friction model', (d) => void ((physics(d)['friction'] as Record<string, unknown>)['model'] = 'foo'), /friction.model must be/);
    bad('stribeck velocity', (d) => void ((physics(d)['friction'] as Record<string, unknown>)['stribeckVelocity'] = 0), /stribeck needs/);
    bad('friction viscous', (d) => void ((physics(d)['friction'] as Record<string, unknown>)['viscous'] = -1), /viscous must be >= 0/);
    bad('friction not an object', (d) => void (physics(d)['friction'] = 4), /friction must be an object/);
    bad('limits reversed', (d) => void (physics(d)['limits'] = { min: 1, max: -1, stiffness: 1 }), /limits need finite min < max/);
    bad('limits stiffness', (d) => void (physics(d)['limits'] = { min: -1, max: 1, stiffness: -1 }), /limits.stiffness/);
    bad('limits restitution', (d) => void (physics(d)['limits'] = { min: -1, max: 1, stiffness: 1, restitution: 0 }), /restitution/);
    bad('armature', (d) => void (physics(d)['armatureKgM2'] = -1), /armatureKgM2/);
    bad('physics key', (d) => void (table(d, 'jointPhysics')['ghost'] = { id: 'ghost', armatureKgM2: 1 }), /no joint 'ghost'/);
    bad('physics id', (d) => void (physics(d)['id'] = 'other'), /whose id is 'j2'/);
    bad('load target', (d) => void (load(d)['target'] = {}), /target must be/);
    bad('load kind', (d) => void (load(d)['kind'] = 'foo'), /kind must be 'force' or 'torque'/);
    bad('load direction', (d) => void (load(d)['direction'] = [1]), /direction must be/);
    bad('load profile type', (d) => void (load(d)['profile'] = 3), /profile must be/);
    bad('load constant', (d) => void (load(d)['constant'] = 'x'), /constant must be finite/);
    bad('load empty', (d) => void delete load(d)['profile'], /needs a profile or a constant/);
    bad('load ghost joint', (d) => void (load(d)['target'] = { joint: 'ghost' }), /no joint 'ghost'/);
    bad('load ghost body', (d) => void (load(d)['target'] = { body: 'ghost' }), /no body 'ghost'/);
    bad('load ghost profile', (d) => void (load(d)['profile'] = 'ghost'), /profile 'ghost' does not exist/);
    bad('gear on a slide', (d) => void (gear(d)['driven'] = 'jn'), /couples a revolute driver with a revolute joint/);
    bad('screw on a hinge', (d) => void (screw(d)['nut'] = 'j2'), /couples a revolute driver with a prismatic joint/);
    bad('load kind against joint', (d) => void (load(d)['kind'] = 'force'), /does not fit the revolute joint 'j'/);
    bad(
      'physics on a ball',
      (d) =>
        void (table(d, 'joints')['j2'] = {
          ...(table(d, 'joints')['j2'] ?? {}),
          kind: 'spherical',
          damping: 0,
          friction: 0,
          initialVelocity: 0,
        }),
      /spherical joint has no coordinate/,
    );
    bad('table not an object', (d) => void (d['transmissions'] = 5), /transmissions must be an object/);
    bad(
      'linear motor',
      (d) => void (table(d, 'motors')['lm'] = { id: 'lm', kind: 'linear_speed', joint: 'jn', speedMps: 'x', maxForceN: 1 }),
      /linear_speed needs/,
    );
  });

  it('a record with a reserved id and a gears table of the old format are refused, not read', () => {
    expect(problemsAfter((d) => void (d['transmissions'] = JSON.parse('{"__proto__": {"id": "__proto__"}}') as unknown)).join('|')).toMatch(
      /__proto__|reserved/,
    );
    expect(
      dynamicsProblems({ ...raw(), transmissions: { g: { id: 'g', kind: 'gear', driver: 'a', driven: 'b', ratio: 1 } } }).join('|'),
    ).toMatch(/joint 'a' does not exist/);
    const accepted = problemsAfter(
      (d) => void (table(d, 'motors')['lm'] = { id: 'lm', kind: 'linear_speed', joint: 'jn', speedMps: 0.1, maxForceN: 5 }),
    );
    expect(accepted).toEqual([]);
  });
});
