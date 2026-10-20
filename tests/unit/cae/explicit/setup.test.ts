/** PHY-19 set-up commands: create_analysis explicit_dynamics, set_explicit_controls, set_initial_velocity, add / delete_rigid_wall (VC-EXP-01, 64). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { ExplicitSpec } from '@core/model/explicit';
import { explicitErrors } from '@cae/explicit/model';
import { barModel, code, must } from './support';

const specOf = (doc: CadDocument, analysisId: string): ExplicitSpec => {
  const spec = doc.analysis?.cases[analysisId]?.explicit;
  if (spec === undefined) throw new Error('no explicit spec');
  return spec;
};

describe('create_analysis explicit_dynamics', () => {
  const boxed = must(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;

  it('defaults the solver to llull_explicit and starts without controls', () => {
    const created = must(boxed, 'create_analysis', { name: 'impact', analysisType: 'explicit_dynamics' });
    const analysis = created.document.analysis?.cases[created.affected[0] ?? ''];
    expect(analysis?.solver).toBe('llull_explicit');
    expect(analysis?.explicit).toBeUndefined();
    expect(created.summary).toContain('explicit_dynamics, llull_explicit');
  });

  it('refuses a solver that cannot run the type (EXP_SOLVER_UNSUPPORTED)', () => {
    expect(code(execute(boxed, 'create_analysis', { name: 'a', analysisType: 'explicit_dynamics', solver: 'calculix' }))).toBe(
      'EXP_SOLVER_UNSUPPORTED',
    );
    expect(code(execute(boxed, 'create_analysis', { name: 'a', analysisType: 'explicit_dynamics', solver: 'opencourant' }))).toBe(
      'EXP_SOLVER_UNSUPPORTED',
    );
    expect(code(execute(boxed, 'create_analysis', { name: 'a', analysisType: 'static', solver: 'llull_explicit' }))).toBe(
      'EXP_SOLVER_UNSUPPORTED',
    );
  });
});

describe('set_explicit_controls', () => {
  const model = barModel();

  it('stores times in seconds and names every defaulted setting (AF-31)', () => {
    const spec = specOf(model.doc, model.analysisId);
    expect(spec.endTimeS).toBe(0.00016);
    expect(spec.historyIntervalS).toBe(1e-6);
    expect(spec.timeStepScale).toMatchObject({ value: 0.9, defaulted: true });
    expect(spec.hourglassCoefficient).toMatchObject({ value: 0.1, defaulted: true });
    expect(spec.bulkViscosity.linear).toMatchObject({ value: 0.06, defaulted: true });
    expect(spec.bulkViscosity.quadratic).toMatchObject({ value: 1.5, defaulted: true });
    expect(spec.mesh).toEqual({ kind: 'structured_hex', size: 2.5 });
    expect(spec.massScaling).toEqual({ mode: 'none' });
    expect(explicitErrors(JSON.parse(JSON.stringify(model.doc)) as Record<string, unknown>)).toEqual([]);
  });

  it('keeps initial velocities and walls, converts units and records given values', () => {
    const before = structuredClone(model.doc);
    const result = must(model.doc, 'set_explicit_controls', {
      analysisId: model.analysisId,
      endTime: { value: 0.2, unit: 'ms' },
      historyInterval: { value: 2, unit: 'us' },
      timeStepScale: { value: 0.5, source: 'company rule X' },
      minTimeStep: { value: 1e-9, unit: 's' },
      massScaling: { mode: 'selective', targetTimeStep: { value: 1e-7, unit: 's' }, maxAddedMassRatio: 0.05 },
      gravity: { vector: [0, 0, -9.80665], unit: 'm/s^2' },
      hourglassCoefficient: { value: 0.05, source: 'study' },
      bulkViscosity: { linear: { value: 0, source: 'test' }, quadratic: { value: 0, source: 'test' } },
      mesh: { kind: 'fea_mesh' },
    });
    expect(model.doc).toEqual(before);
    const spec = specOf(result.document, model.analysisId);
    expect(spec.endTimeS).toBeCloseTo(2e-4, 15);
    expect(spec.historyIntervalS).toBeCloseTo(2e-6, 15);
    expect(spec.timeStepScale).toEqual({ value: 0.5, source: 'company rule X', defaulted: false });
    expect(spec.gravity?.[2]).toBeCloseTo(-9806.65, 9);
    expect(spec.massScaling).toEqual({ mode: 'selective', targetTimeStepS: 1e-7, maxAddedMassRatio: 0.05 });
    expect(spec.minTimeStepS).toBe(1e-9);
    expect(spec.mesh).toEqual({ kind: 'fea_mesh' });
    expect(Object.keys(spec.initialVelocities)).toHaveLength(1);
    expect(spec.rigidWallOrder).toEqual([model.wallId]);
    expect(result.summary).toContain('0 named default(s)');
  });

  it('refuses bad set-ups with their codes (VC-EXP-64)', () => {
    const base = { analysisId: model.analysisId, endTime: { value: 1, unit: 's' }, historyInterval: { value: 0.1, unit: 's' } };
    const refused = (extra: Record<string, unknown>): string | undefined =>
      code(execute(model.doc, 'set_explicit_controls', { ...base, ...extra }));
    expect(refused({ endTime: { value: 0, unit: 's' } })).toBe('EXP_TIME_INVALID');
    expect(refused({ endTime: { value: 1, unit: 'kg' } })).toBe('EXP_TIME_INVALID');
    expect(refused({ historyInterval: { value: 2, unit: 's' } })).toBe('EXP_TIME_INVALID');
    expect(refused({ minTimeStep: { value: -1, unit: 's' } })).toBe('EXP_TIME_INVALID');
    expect(refused({ massScaling: { mode: 'selective', targetTimeStep: { value: 1e-6, unit: 's' } } })).toBe(
      'EXP_MASS_SCALING_LIMIT_MISSING',
    );
    expect(refused({ massScaling: { mode: 'selective', targetTimeStep: { value: 0, unit: 's' }, maxAddedMassRatio: 0.1 } })).toBe(
      'EXP_TIME_INVALID',
    );
    expect(refused({ massScaling: { mode: 'selective', targetTimeStep: { value: 1, unit: 's' }, maxAddedMassRatio: -1 } })).toBe(
      'EXP_PARAM_INVALID',
    );
    expect(refused({ timeStepScale: { value: 1.5, source: 'x' } })).toBe('EXP_PARAM_INVALID');
    expect(refused({ hourglassCoefficient: { value: 0.9, source: 'x' } })).toBe('EXP_PARAM_INVALID');
    expect(refused({ bulkViscosity: { linear: { value: -1, source: 'x' }, quadratic: { value: 1, source: 'x' } } })).toBe(
      'EXP_PARAM_INVALID',
    );
    expect(refused({ gravity: { vector: [0, 0, -1], unit: 'mm/s' } })).toBe('EXP_PARAM_INVALID');
    expect(refused({ mesh: { kind: 'structured_hex' } })).toBe('EXP_PARAM_INVALID');
    expect(code(execute(model.doc, 'set_explicit_controls', { ...base, analysisId: 'an-404' }))).toBe('FEA_ANALYSIS_NOT_FOUND');
  });

  it('refuses a non-explicit case and an unsupported unit system', () => {
    const boxed = must(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    const staticCase = must(boxed.document, 'create_analysis', { name: 's', analysisType: 'static' });
    const params = { endTime: { value: 1, unit: 's' }, historyInterval: { value: 0.1, unit: 's' } };
    expect(code(execute(staticCase.document, 'set_explicit_controls', { analysisId: staticCase.affected[0], ...params }))).toBe(
      'EXP_CASE_TYPE',
    );
    const inches = must(must(createEmptyDocument(), 'set_units', { units: 'in' }).document, 'create_analysis', {
      name: 'i',
      analysisType: 'explicit_dynamics',
    });
    expect(code(execute(inches.document, 'set_explicit_controls', { analysisId: inches.affected[0], ...params }))).toBe(
      'EXP_UNITS_UNSUPPORTED',
    );
  });
});

describe('set_initial_velocity, add_rigid_wall, delete_rigid_wall', () => {
  const model = barModel();

  it('stores one velocity per part in the case unit and removes it with a zero vector', () => {
    const spec = specOf(model.doc, model.analysisId);
    expect(Object.values(spec.initialVelocities)).toEqual([{ entityId: model.barId, velocity: [0, 0, -10000] }]);
    const metres = must(model.doc, 'set_initial_velocity', {
      analysisId: model.analysisId,
      entityId: model.barId,
      velocity: { vector: [0, 0, -5], unit: 'm/s' },
    });
    expect(Object.values(specOf(metres.document, model.analysisId).initialVelocities)).toEqual([
      { entityId: model.barId, velocity: [0, 0, -5000] },
    ]);
    const cleared = must(metres.document, 'set_initial_velocity', {
      analysisId: model.analysisId,
      entityId: model.barId,
      velocity: { vector: [0, 0, 0], unit: 'm/s' },
    });
    expect(specOf(cleared.document, model.analysisId).initialVelocities).toEqual({});
    expect(cleared.summary).toContain('no initial velocity');
  });

  it('refuses parts outside the case, bad units and cases without controls', () => {
    const velocity = { vector: [1, 0, 0], unit: 'mm/s' };
    expect(code(execute(model.doc, 'set_initial_velocity', { analysisId: model.analysisId, entityId: 'box-404', velocity }))).toBe(
      'EXP_TARGET_NOT_IN_CASE',
    );
    expect(
      code(
        execute(model.doc, 'set_initial_velocity', {
          analysisId: model.analysisId,
          entityId: model.barId,
          velocity: { ...velocity, unit: 'N' },
        }),
      ),
    ).toBe('EXP_PARAM_INVALID');
    const fresh = must(model.doc, 'create_analysis', { name: 'b', analysisType: 'explicit_dynamics' });
    expect(code(execute(fresh.document, 'set_initial_velocity', { analysisId: fresh.affected[0], entityId: model.barId, velocity }))).toBe(
      'EXP_CONTROLS_MISSING',
    );
    expect(
      code(execute(fresh.document, 'add_rigid_wall', { analysisId: fresh.affected[0], name: 'w', point: [0, 0, 0], normal: [0, 0, 1] })),
    ).toBe('EXP_CONTROLS_MISSING');
  });

  it('adds and deletes walls purely; refuses zero normals, duplicate names and unknown walls', () => {
    const before = structuredClone(model.doc);
    const added = must(model.doc, 'add_rigid_wall', { analysisId: model.analysisId, name: 'side', point: [0, 0, 0], normal: [1, 0, 0] });
    expect(model.doc).toEqual(before);
    const wallId = added.affected[1] ?? '';
    expect(specOf(added.document, model.analysisId).rigidWallOrder).toEqual([model.wallId, wallId]);
    const removed = must(added.document, 'delete_rigid_wall', { analysisId: model.analysisId, wallId });
    expect(specOf(removed.document, model.analysisId).rigidWallOrder).toEqual([model.wallId]);
    expect(
      code(execute(model.doc, 'add_rigid_wall', { analysisId: model.analysisId, name: 'x', point: [0, 0, 0], normal: [0, 0, 0] })),
    ).toBe('EXP_RIGID_WALL_INVALID');
    expect(
      code(execute(model.doc, 'add_rigid_wall', { analysisId: model.analysisId, name: 'anvil', point: [0, 0, 0], normal: [0, 0, 1] })),
    ).toBe('EXP_RIGID_WALL_INVALID');
    expect(code(execute(model.doc, 'delete_rigid_wall', { analysisId: model.analysisId, wallId: 'rw-404' }))).toBe(
      'EXP_RIGID_WALL_NOT_FOUND',
    );
  });

  it('flags malformed explicit slices on load', () => {
    const raw = JSON.parse(JSON.stringify(model.doc)) as { analysis: { cases: Record<string, Record<string, unknown>> } };
    const analysis = raw.analysis.cases[model.analysisId];
    if (analysis === undefined) throw new Error('no case');
    analysis['explicit'] = {
      endTimeS: -1,
      historyIntervalS: 1,
      mesh: { kind: 'x' },
      massScaling: {},
      gravity: [1],
      initialVelocities: 3,
      rigidWalls: {},
      rigidWallOrder: ['nope'],
    };
    expect(explicitErrors(raw as unknown as Record<string, unknown>)).toHaveLength(7);
    analysis['explicit'] = 5;
    expect(explicitErrors(raw as unknown as Record<string, unknown>)).toEqual([`analysis.cases.${model.analysisId}.explicit is malformed`]);
    expect(explicitErrors({})).toEqual([]);
  });
});
