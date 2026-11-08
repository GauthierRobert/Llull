/** PHY-11 M2 set-up (TR-CRP-01, 02, 10, 11; FR-CRP-01, 13): create_analysis creep, set_creep_step / delete_creep_step, load validation, input hash, replay. */
import { describe, expect, it } from 'vitest';
import { execute, toToolSchemas } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { analysisErrors } from '@cae/model/validate';
import { caseOf, withCase } from '@cae/shared/access';
import { creepCube, must, STEP, type CreepCube } from './support';

const MINIMAL = { duration: { value: 1000, unit: 's' }, cetol: 1e-3, temperature: { value: 293, unit: 'K' } };

const run = (c: CreepCube, params: Record<string, unknown>, doc: CadDocument = c.doc): ReturnType<typeof execute> =>
  execute(doc, 'set_creep_step', { analysisId: c.analysisId, ...params });

const creepOf = (c: CreepCube, doc: CadDocument = c.doc): NonNullable<ReturnType<typeof caseOf>>['creep'] =>
  caseOf(doc, c.analysisId)?.creep;

describe('create_analysis creep', () => {
  it('creates a creep case on calculix with the document unit system; calculix is the only solver', () => {
    const { doc, analysisId } = creepCube({ step: null });
    expect(caseOf(doc, analysisId)).toMatchObject({ type: 'creep', solver: 'calculix', unitSystem: 'N-mm-t-s' });
    const refused = execute(doc, 'create_analysis', { name: 'x', analysisType: 'creep', solver: 'opencourant' });
    expect(refused.error?.code).toBe('CRP_SOLVER_UNSUPPORTED');
    expect(refused.document).toBe(doc);
  });
});

describe('set_creep_step', () => {
  it('stores the hold in seconds / kelvin, resolves and names every default, replaces the previous hold, and is pure', () => {
    const c = creepCube({ step: null });
    const before = structuredClone(c.doc);
    const result = run(c, MINIMAL);
    expect(result.error).toBeUndefined();
    expect(c.doc).toEqual(before);
    expect(result.affected).toEqual([c.analysisId]);
    expect(creepOf(c, result.document)).toEqual({
      preloadStep: true,
      preloadPeriodS: 1e-3,
      durationS: 1000,
      initialIncrementS: 1,
      maxIncrements: 1000,
      cetol: 1e-3,
      nlgeom: false,
      temperature: { kind: 'uniform', valueK: 293 },
      outputTimes: { kind: 'log', count: 50 },
    });
    for (const named of ['initialIncrement 1 s', 'maxIncrements 1000', 'preloadStep true', 'nlgeom false', 'outputTimes log 50'])
      expect(result.summary).toContain(named);
    const again = run(
      c,
      { ...MINIMAL, duration: { value: 1, unit: 'h' }, preloadStep: false, maxIncrement: { value: 30, unit: 'min' } },
      result.document,
    );
    expect(creepOf(c, again.document)).toMatchObject({ durationS: 3600, preloadStep: false, preloadPeriodS: 0, maxIncrementS: 1800 });
    expect(again.summary).toContain('no preload step');
  });

  it('converts the temperature unit (20 degC = 293.15 K) and accepts every given option: min / max increment, nlgeom, linear output', () => {
    const c = creepCube({ step: null, validityK: [200, 400] });
    const result = run(c, {
      ...MINIMAL,
      temperature: { value: 20, unit: 'degC' },
      initialIncrement: { value: 2, unit: 's' },
      minIncrement: { value: 0.5, unit: 's' },
      maxIncrement: { value: 100, unit: 's' },
      maxIncrements: 300,
      nlgeom: true,
      preloadStep: false,
      outputTimes: { kind: 'linear', every: { value: 100, unit: 's' } },
    });
    expect(result.error).toBeUndefined();
    expect(creepOf(c, result.document)).toMatchObject({
      temperature: { valueK: 293.15 },
      initialIncrementS: 2,
      minIncrementS: 0.5,
      maxIncrementS: 100,
      maxIncrements: 300,
      nlgeom: true,
      outputTimes: { kind: 'linear', everyS: 100 },
    });
    expect(result.summary).not.toContain('defaults:');
  });

  it('the creep step is part of the full input hash (results go stale), not of the mesh hash (the mesh stays valid)', () => {
    const c = creepCube();
    const longer = run(c, { ...STEP, duration: { value: 2000, unit: 's' } });
    expect(analysisInputHash(longer.document, c.analysisId, 'full')).not.toBe(analysisInputHash(c.doc, c.analysisId, 'full'));
    expect(analysisInputHash(longer.document, c.analysisId, 'mesh')).toBe(analysisInputHash(c.doc, c.analysisId, 'mesh'));
    const removed = execute(c.doc, 'delete_creep_step', { analysisId: c.analysisId });
    expect(analysisInputHash(removed.document, c.analysisId, 'full')).not.toBe(analysisInputHash(c.doc, c.analysisId, 'full'));
  });

  it('survives a history replay with the same creep step', () => {
    const c = creepCube();
    const replayed = execute(c.doc, 'replay_history', {});
    expect(replayed.error).toBeUndefined();
    expect(creepOf(c, replayed.document)).toEqual(creepOf(c));
  });

  it.each([
    ['duration 0', { duration: { value: 0, unit: 's' } }, 'CRP_DURATION_INVALID', 'duration'],
    ['duration in a non-time unit', { duration: { value: 5, unit: 'MPa' } }, 'CRP_DURATION_INVALID', 'duration'],
    [
      'minimum above the initial increment',
      { initialIncrement: { value: 1, unit: 's' }, minIncrement: { value: 2, unit: 's' } },
      'CRP_STEP_PARAM_INVALID',
      'initialIncrement',
    ],
    ['maximum above the duration', { maxIncrement: { value: 2000, unit: 's' } }, 'CRP_STEP_PARAM_INVALID', 'initialIncrement'],
    ['increment in a bad unit', { initialIncrement: { value: 1, unit: 'kg' } }, 'CRP_STEP_PARAM_INVALID', 'initialIncrement'],
    ['temperature in a bad unit', { temperature: { value: 5, unit: 'MPa' } }, 'CRP_STEP_PARAM_INVALID', 'temperature'],
    [
      'too many linear output times',
      { outputTimes: { kind: 'linear', every: { value: 1, unit: 's' } } },
      'CRP_STEP_PARAM_INVALID',
      'outputTimes',
    ],
    [
      'linear output in a bad unit',
      { outputTimes: { kind: 'linear', every: { value: 1, unit: 'N' } } },
      'CRP_STEP_PARAM_INVALID',
      'outputTimes',
    ],
  ])('refuses %s with %s and the path, unchanged document', (_name, patch, code, path) => {
    const c = creepCube({ step: null });
    const result = run(c, { ...MINIMAL, ...patch });
    expect(result.rejected).toBe(true);
    expect(result.error).toMatchObject({ code, paths: [path], ids: [c.analysisId] });
    expect(result.document).toBe(c.doc);
    expect(result.affected).toEqual([]);
  });

  it('puts the integer ranges in the tool schema and refuses outside them as invalid params', () => {
    const c = creepCube({ step: null });
    for (const patch of [
      { maxIncrements: 0 },
      { maxIncrements: 2_000_000 },
      { outputTimes: { kind: 'log', count: 1 } },
      { outputTimes: { kind: 'log', count: 201 } },
    ])
      expect(run(c, { ...MINIMAL, ...patch }).error?.code).toBe('CMD_INVALID_PARAMS');
    // the tool-schema derivation carries no minimum / maximum (none in the snapshot): the range is validated by zod and stated in the description
    const schema = JSON.stringify(toToolSchemas().find((tool) => tool.name === 'set_creep_step'));
    expect(schema).toContain('1 to 1000000');
  });

  it('refuses a case whose unit system is not N-mm-t-s at the set-up, not only at the deck', () => {
    const c = creepCube({ step: null });
    const analysis = caseOf(c.doc, c.analysisId);
    if (analysis === undefined) throw new Error('no case');
    const metre = withCase(c.doc, { ...analysis, unitSystem: 'N-m-kg-s' });
    expect(run(c, MINIMAL, metre).error).toMatchObject({ code: 'CRP_UNIT_SYSTEM', ids: [c.analysisId] });
    expect(execute(metre, 'check_creep', { analysisId: c.analysisId }).data).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ code: 'CRP_UNIT_SYSTEM' })]),
    });
  });

  it('refuses an unknown case, a case of another type, a case of another solver, a case without part', () => {
    const c = creepCube({ step: null });
    expect(execute(c.doc, 'set_creep_step', { analysisId: 'nope', ...MINIMAL }).error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
    const stat = creepCube({ type: 'static' });
    expect(run(stat, MINIMAL).error?.code).toBe('CRP_CASE_TYPE');
    const analysis = caseOf(c.doc, c.analysisId);
    if (analysis === undefined) throw new Error('no case');
    const other = withCase(c.doc, { ...analysis, solver: 'nastran' });
    expect(run(c, MINIMAL, other).error?.code).toBe('CRP_SOLVER_UNSUPPORTED');
    const empty = withCase(c.doc, { ...analysis, parts: {} });
    expect(run(c, MINIMAL, empty).error?.code).toBe('CRP_NO_VISCOUS_MATERIAL');
  });

  it.each([
    ['a material without a creep law', { creep: false }, 'CRP_LAW_MISSING'],
    ['a strain-hardening law', { law: { hardening: 'strain' } }, 'CRP_LAW_FORM_UNSUPPORTED'],
    ['a law in hours (the cards do not convert the time unit)', { law: { timeUnit: 'h' } }, 'CRP_LAW_TIME_UNIT'],
    ['orthotropic elasticity', { elastic: 'orthotropic' }, 'CRP_ORTHOTROPIC_V2'],
    ['a hold temperature outside the law validity', { validityK: [400, 500] }, 'CRP_LAW_OUT_OF_RANGE'],
  ] as const)('refuses %s with %s, naming the part and the material', (_name, options, code) => {
    const c = creepCube({ ...options, step: null });
    const result = run(c, MINIMAL);
    expect(result.error).toMatchObject({ code, ids: expect.arrayContaining([c.cube, 'norton']) });
    expect(result.document).toBe(c.doc);
  });

  it('refuses a part without a material', () => {
    const c = creepCube({ step: null });
    const bare = must(c.doc, 'create_material', { name: 'other', density: 0.0078, color: '#999999', metalness: 1, roughness: 0.4 }).doc;
    const unassigned = {
      ...bare,
      entities: { ...bare.entities, [c.cube]: { ...bare.entities[c.cube], materialId: undefined } },
    } as unknown as CadDocument;
    expect(run(c, MINIMAL, unassigned).error).toMatchObject({ code: 'CRP_LAW_MISSING', ids: [c.cube] });
  });
});

describe('delete_creep_step', () => {
  it('removes the hold; a second call and a case of another type are refused', () => {
    const c = creepCube();
    const before = structuredClone(c.doc);
    const result = execute(c.doc, 'delete_creep_step', { analysisId: c.analysisId });
    expect(c.doc).toEqual(before);
    expect(result.affected).toEqual([c.analysisId]);
    expect(creepOf(c, result.document)).toBeUndefined();
    const again = execute(result.document, 'delete_creep_step', { analysisId: c.analysisId });
    expect(again.error?.code).toBe('CRP_NOTHING_TO_DELETE');
    const stat = creepCube({ type: 'static' });
    expect(execute(stat.doc, 'delete_creep_step', { analysisId: stat.analysisId }).error?.code).toBe('CRP_CASE_TYPE');
    expect(execute(c.doc, 'delete_creep_step', { analysisId: 'nope' }).error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
  });
});

describe('creep slice validation on load', () => {
  const errorsWith = (c: CreepCube, patch: Record<string, unknown>, root: Record<string, unknown> = {}): string[] => {
    const analysis = caseOf(c.doc, c.analysisId);
    if (analysis === undefined) throw new Error('no case');
    const creep = { ...analysis.creep, ...patch };
    return analysisErrors(withCase(c.doc, { ...analysis, ...root, creep } as typeof analysis) as unknown as Record<string, unknown>);
  };

  it('accepts what set_creep_step stores and rejects malformed or inconsistent steps', () => {
    const c = creepCube();
    expect(errorsWith(c, {})).toEqual([]);
    expect(errorsWith(c, { durationS: -1 }).join()).toContain('creep.durationS');
    expect(errorsWith(c, { cetol: 0 }).join()).toContain('creep.cetol');
    expect(errorsWith(c, { maxIncrements: 1.5 }).join()).toContain('creep.maxIncrements');
    expect(errorsWith(c, { temperature: { kind: 'field', valueK: 3 } }).join()).toContain('creep.temperature');
    expect(errorsWith(c, { outputTimes: { kind: 'log', count: 1 } }).join()).toContain('creep.outputTimes');
    expect(errorsWith(c, { preloadPeriodS: 0 }).join()).toContain('preloadPeriodS must be > 0 exactly when preloadStep is true');
    expect(errorsWith(c, { preloadStep: false }).join()).toContain('preloadPeriodS must be > 0 exactly when preloadStep is true');
    expect(errorsWith(c, { minIncrementS: 5 }).join()).toContain('min <= initial <= max <= duration');
    expect(errorsWith(c, { maxIncrementS: 5000 }).join()).toContain('min <= initial <= max <= duration');
    expect(errorsWith(c, { outputTimes: { kind: 'linear', everyS: 1 } }).join()).toContain('at most 200 times');
    expect(errorsWith(c, { outputTimes: { kind: 'linear', everyS: 5000 } }).join()).toContain('at most 200 times');
  });

  it('rejects a creep step on a case that is not creep, and the ceeq probe on an analysis type that has no creep strain', () => {
    const c = creepCube();
    expect(errorsWith(c, {}, { type: 'static' }).join()).toContain('only creep cases carry a creep step');
    const probe = creepCube({ probes: [{ name: 'p', quantity: 'ceeq' }] });
    expect(analysisErrors(probe.doc as unknown as Record<string, unknown>)).toEqual([]);
    const stat = creepCube({ type: 'static' });
    const refused = execute(stat.doc, 'add_result_probe', {
      analysisId: stat.analysisId,
      name: 'p',
      point: [0.5, 0.5, 0.5],
      quantity: 'ceeq',
    });
    expect(refused.error?.code).toBe('FEA_PROBE_INVALID');
  });
});
