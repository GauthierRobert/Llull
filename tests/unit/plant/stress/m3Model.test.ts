/**
 * PST-M3 model commands: create / update / delete_stress_model, set_pipe_operating_conditions, set_stress_load_cases, add / delete_stress_restraint,
 * and the coded refusals of analyze_pipe_stress (happy path and failure path of each, purity, replay re-mints identical ids).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { strainModel, withModel as withMaterial } from '../../physics/thermomech/thermomechFixtures';
import { analyzed, anchorAt, baseDoc, cases, conditioned, DN100, steel, withModel, withPipe } from './m3Fixtures';

const ROUTE = [
  [0, 0, 3000],
  [6000, 0, 3000],
];
const scene = (): { doc: CadDocument; pipeId: string; id: string } => {
  const { doc, id: pipeId } = withPipe(baseDoc(), ROUTE, DN100.odMm);
  const { doc: modelled, id } = withModel(doc, [pipeId]);
  return { doc: modelled, pipeId, id };
};

describe('create_stress_model', () => {
  it('stores references and rules: a step-scoped id, the scope kind, named defaults listed, the model in order', () => {
    const { doc: pipes, id: pipeId } = withPipe(baseDoc(), ROUTE, DN100.odMm);
    const result = ok(pipes, 'create_stress_model', { name: 'Hot line', pipeIds: [pipeId, pipeId], rule: 'B31.3-2018' });
    const model = result.document.plant?.stress?.models[result.affected[0] as string];
    expect(result.affected).toHaveLength(1);
    expect(result.affected[0]).toMatch(/^stress-\d+\.\d+$/);
    expect(model).toMatchObject({
      name: 'Hot line',
      scope: { kind: 'pipes', ids: [pipeId] },
      rule: 'B31.3-2018',
      maxElementLengthMm: 3000,
      elbowRadiusFactor: 1.5,
      frictionCoefficient: 0.3,
      defaulted: ['maxElementLengthMm', 'elbowRadiusFactor', 'frictionCoefficient'],
    });
    expect(result.document.plant?.stress?.modelOrder).toEqual([result.affected[0]]);
    expect(result.data).toMatchObject({
      rule: 'B31.3-2018',
      defaulted: ['maxElementLengthMm', 'elbowRadiusFactor', 'frictionCoefficient'],
    });
    expectPure(pipes, () => execute(pipes, 'create_stress_model', { name: 'x', pipeIds: [pipeId], rule: 'B31.1-2016' }));
  });

  it('an explicitly given value is not listed as defaulted', () => {
    const { doc: pipes, id: pipeId } = withPipe(baseDoc(), ROUTE, DN100.odMm);
    const result = ok(pipes, 'create_stress_model', {
      name: 'x',
      pipeIds: [pipeId],
      rule: 'B31.3-2022',
      maxElementLengthMm: 1000,
      elbowRadiusFactor: 0,
      frictionCoefficient: 0.1,
    });
    expect((result.data as { defaulted: string[] }).defaulted).toEqual([]);
  });

  it('refuses with codes: neither or both scopes, unknown pipe, unknown line, mixed kinds, a document not in mm', () => {
    const { doc: pipes, id: pipeId } = withPipe(baseDoc(), ROUTE, DN100.odMm);
    const base = { name: 'x', rule: 'B31.3-2018' };
    expectRefusal(pipes, 'create_stress_model', base, 'PST_PARAM_INVALID', 'pipeIds');
    expectRefusal(pipes, 'create_stress_model', { ...base, pipeIds: [pipeId], lineId: 'L' }, 'PST_PARAM_INVALID');
    expectRefusal(pipes, 'create_stress_model', { ...base, pipeIds: ['ghost'] }, 'PST_PIPE_NOT_FOUND', 'pipeIds');
    expectRefusal(pipes, 'create_stress_model', { ...base, lineId: 'ghost' }, 'PST_NO_PIPES', 'lineId');
    expectRefusal(
      apply(pipes, 'set_units', { units: 'm' }),
      'create_stress_model',
      { ...base, pipeIds: [pipeId] },
      'PST_PARAM_INVALID',
      'units',
    );
    // a level id is a building element but not a pipe
    const level = Object.keys(pipes.building?.levels ?? {})[0] as string;
    expectRefusal(pipes, 'create_stress_model', { ...base, pipeIds: [level] }, 'PST_PIPE_NOT_FOUND');
  });

  it('replay re-mints identical ids and the saved document round-trips with the slice validated', () => {
    const { doc, id } = scene();
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(replayed.plant?.stress).toEqual(doc.plant?.stress);
    expect(Object.keys(replayed.plant?.stress?.models ?? {})).toEqual([id]);
    expect(deserializeDocument(serializeDocument(doc)).plant?.stress).toEqual(doc.plant?.stress);
  });

  it('a corrupt stored slice is rejected on load', () => {
    const { doc } = scene();
    const raw = JSON.parse(serializeDocument(doc)) as { document: { plant: { stress: { models: Record<string, { rule: string }> } } } };
    const key = Object.keys(raw.document.plant.stress.models)[0] as string;
    (raw.document.plant.stress.models[key] as { rule: string }).rule = 'B31.3-1999';
    expect(() => deserializeDocument(JSON.stringify(raw))).toThrow();
    const orphaned = JSON.parse(serializeDocument(doc)) as { document: { plant: { stress: { modelOrder: string[] } } } };
    orphaned.document.plant.stress.modelOrder = [];
    expect(() => deserializeDocument(JSON.stringify(orphaned))).toThrow();
  });
});

describe('update_stress_model / delete_stress_model', () => {
  it('replaces only the given fields, removes them from the defaulted list, keeps conditions', () => {
    const { doc, id } = scene();
    const withConditions = conditioned(doc, id);
    const result = ok(withConditions, 'update_stress_model', {
      modelId: id,
      name: 'Renamed',
      frictionCoefficient: 0.1,
      rule: 'B31.1-2018',
    });
    const model = result.document.plant?.stress?.models[id];
    expect(model).toMatchObject({ name: 'Renamed', frictionCoefficient: 0.1, rule: 'B31.1-2018', elbowRadiusFactor: 0 });
    expect(model?.defaulted).toEqual([]);
    expect(model?.conditions).toBeDefined();
    expect(result.affected).toEqual([id]);
  });

  it('re-scopes to other pipes and refuses unknown ones, an empty change and an unknown model', () => {
    const { doc, id, pipeId } = scene();
    const second = withPipe(
      doc,
      [
        [0, 2000, 3000],
        [3000, 2000, 3000],
      ],
      DN100.odMm,
    );
    const result = ok(second.doc, 'update_stress_model', { modelId: id, pipeIds: [pipeId, second.id] });
    expect(result.document.plant?.stress?.models[id]?.scope.ids).toEqual([pipeId, second.id]);
    expectRefusal(doc, 'update_stress_model', { modelId: id, pipeIds: ['ghost'] }, 'PST_PIPE_NOT_FOUND');
    expectRefusal(doc, 'update_stress_model', { modelId: id }, 'PST_PARAM_INVALID');
    expectRefusal(doc, 'update_stress_model', { modelId: 'ghost', name: 'x' }, 'PST_MODEL_NOT_FOUND', 'modelId');
  });

  it('deletes a model with its order entry; an unknown id is refused', () => {
    const { doc, id } = scene();
    const result = ok(doc, 'delete_stress_model', { modelId: id });
    expect(result.document.plant?.stress).toEqual({ models: {}, modelOrder: [] });
    expectRefusal(doc, 'delete_stress_model', { modelId: 'ghost' }, 'PST_MODEL_NOT_FOUND');
    expectPure(doc, () => execute(doc, 'delete_stress_model', { modelId: id }));
  });
});

describe('set_pipe_operating_conditions', () => {
  it('stores the conditions, lists every named default and returns the thermal strain per temperature', () => {
    const { doc, id } = scene();
    const result = ok(doc, 'set_pipe_operating_conditions', {
      modelId: id,
      temperatures: [{ name: 'T1', tempC: 204.4 }],
      material: { youngsModulusMPa: 200000, ShMPa: 138, ScMPa: 138, thermal: { table: 'carbon-steel-c1' } },
    });
    const conditions = result.document.plant?.stress?.models[id]?.conditions;
    expect(conditions).toMatchObject({ installTempC: 21.1, cycles: 7000, corrosionAllowanceMm: 0, poissonPressure: false });
    expect(conditions?.defaulted).toEqual([
      'installTempC',
      'cycles',
      'corrosionAllowanceMm',
      'fluidDensityKgM3',
      'material.poisson',
      'material.densityKgM3',
      'material.ferrousLowStrength',
      'poissonPressure',
    ]);
    const strains = (result.data as { strains: Record<string, number> }).strains;
    expect(strains['T1']).toBeCloseTo(2.2506e-3, 5);
  });

  it('a document material with a thermalStrain model is read through the PHY-01 validity range', () => {
    const { doc, id } = scene();
    const withMat = withMaterial(doc, 'mat', strainModel(1.2e-5));
    const result = ok(withMat, 'set_pipe_operating_conditions', {
      modelId: id,
      installTempC: 20,
      temperatures: [{ name: 'T1', tempC: 120 }],
      material: { youngsModulusMPa: 200000, ShMPa: 138, ScMPa: 138, thermal: { materialId: 'mat' } },
    });
    expect((result.data as { strains: Record<string, number> }).strains['T1']).toBeCloseTo(1.2e-3, 9);
    const base = { modelId: id, installTempC: 20, material: { youngsModulusMPa: 200000, ShMPa: 138, ScMPa: 138 } };
    expectRefusal(
      withMat,
      'set_pipe_operating_conditions',
      { ...base, temperatures: [{ name: 'T1', tempC: 600 }], material: { ...base.material, thermal: { materialId: 'mat' } } },
      'PST_TEMPERATURE_OUT_OF_TABLE',
    );
    expectRefusal(
      withMat,
      'set_pipe_operating_conditions',
      { ...base, temperatures: [{ name: 'T1', tempC: 100 }], material: { ...base.material, thermal: { materialId: 'ghost' } } },
      'PST_MATERIAL_NOT_FOUND',
    );
  });

  it('refuses a temperature outside the table (never extrapolated), repeated names and an unknown model', () => {
    const { doc, id } = scene();
    const base = steel();
    expectRefusal(
      doc,
      'set_pipe_operating_conditions',
      { modelId: id, ...base, temperatures: [{ name: 'T1', tempC: 900 }] },
      'PST_TEMPERATURE_OUT_OF_TABLE',
    );
    expectRefusal(
      doc,
      'set_pipe_operating_conditions',
      {
        modelId: id,
        ...base,
        temperatures: [
          { name: 'T1', tempC: 100 },
          { name: 'T1', tempC: 200 },
        ],
      },
      'PST_PARAM_INVALID',
      'temperatures',
    );
    expectRefusal(doc, 'set_pipe_operating_conditions', { modelId: 'ghost', ...base }, 'PST_MODEL_NOT_FOUND');
    expectRefusal(doc, 'set_pipe_operating_conditions', { modelId: id, ...base, installTempC: -100 }, 'PST_TEMPERATURE_OUT_OF_TABLE');
  });
});

describe('set_stress_load_cases', () => {
  it('the b31.3-default preset builds SUS = W + P1, OPE = W + T1 + P1 and EXP = OPE - SUS from the conditions', () => {
    const { doc, id } = scene();
    const ready = conditioned(doc, id, { pressures: [{ name: 'P1', gaugeBar: 20 }] });
    const result = ok(ready, 'set_stress_load_cases', { modelId: id, preset: 'b31.3-default' });
    expect(result.document.plant?.stress?.models[id]?.loadCases).toEqual([
      { name: 'L1', type: 'SUS', basic: ['W', 'P1'] },
      { name: 'L2', type: 'OPE', basic: ['W', 'T1', 'P1'] },
      {
        name: 'L3',
        type: 'EXP',
        combine: [
          { case: 'L2', factor: 1 },
          { case: 'L1', factor: -1 },
        ],
      },
    ]);
    const noPressure = apply(conditioned(doc, id), 'set_stress_load_cases', { modelId: id, preset: 'b31.3-default' });
    expect(noPressure.plant?.stress?.models[id]?.loadCases[0]?.basic).toEqual(['W']);
  });

  it('refuses the preset without conditions or without T1, and both / neither of preset and cases', () => {
    const { doc, id } = scene();
    expectRefusal(doc, 'set_stress_load_cases', { modelId: id, preset: 'b31.3-default' }, 'PST_CONDITIONS_MISSING');
    expectRefusal(
      conditioned(doc, id, { temperatures: [] }),
      'set_stress_load_cases',
      { modelId: id, preset: 'b31.3-default' },
      'PST_LOADCASE_INVALID',
    );
    expectRefusal(doc, 'set_stress_load_cases', { modelId: id }, 'PST_PARAM_INVALID');
    expectRefusal(
      doc,
      'set_stress_load_cases',
      { modelId: id, preset: 'b31.3-default', cases: [{ name: 'A', type: 'SUS', basic: ['W'] }] },
      'PST_PARAM_INVALID',
    );
  });

  it('validates the cases: duplicate names, unknown or EXP combination targets, missing primitives, forces', () => {
    const { doc, id, pipeId } = scene();
    const set = (list: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({ modelId: id, cases: list, ...extra });
    const sus = { name: 'A', type: 'SUS', basic: ['W'] };
    expectRefusal(doc, 'set_stress_load_cases', set([sus, sus]), 'PST_LOADCASE_INVALID', 'cases.1.name');
    expectRefusal(
      doc,
      'set_stress_load_cases',
      set([{ name: 'X', type: 'EXP', combine: [{ case: 'ghost', factor: 1 }] }]),
      'PST_LOADCASE_INVALID',
    );
    expectRefusal(
      doc,
      'set_stress_load_cases',
      set([
        sus,
        { name: 'X', type: 'EXP', combine: [{ case: 'A', factor: 1 }] },
        { name: 'Y', type: 'EXP', combine: [{ case: 'X', factor: 1 }] },
      ]),
      'PST_LOADCASE_INVALID',
    );
    expectRefusal(doc, 'set_stress_load_cases', set([{ name: 'X', type: 'EXP' }]), 'PST_LOADCASE_INVALID', 'cases.0.combine');
    expectRefusal(
      doc,
      'set_stress_load_cases',
      set([{ name: 'X', type: 'EXP', basic: ['W'], combine: [{ case: 'A', factor: 1 }] }, sus]),
      'PST_LOADCASE_INVALID',
      'cases.0.basic',
    );
    expectRefusal(doc, 'set_stress_load_cases', set([{ name: 'X', type: 'OPE' }]), 'PST_LOADCASE_INVALID', 'cases.0.basic');
    expectRefusal(
      doc,
      'set_stress_load_cases',
      set([{ name: 'X', type: 'OPE', basic: ['W'], combine: [] }]),
      'PST_LOADCASE_INVALID',
      'cases.0.combine',
    );
    expectRefusal(doc, 'set_stress_load_cases', set([{ name: 'X', type: 'OCC', basic: ['W', 'F1'] }]), 'PST_LOADCASE_INVALID');
    const force = { name: 'F1', pipeId, atMm: 3000, forceN: [0, 0, -100] };
    const good = ok(doc, 'set_stress_load_cases', set([{ name: 'X', type: 'OCC', basic: ['W', 'F1'] }], { forces: [force] }));
    expect(good.document.plant?.stress?.models[id]?.forces).toEqual([force]);
    expectRefusal(doc, 'set_stress_load_cases', set([sus], { forces: [{ ...force, pipeId: 'ghost' }] }), 'PST_PIPE_NOT_FOUND', 'forces');
  });
});

describe('add_stress_restraint / delete_stress_restraint', () => {
  it('appends restraints with step-scoped ids and removes them again', () => {
    const { doc, id, pipeId } = scene();
    const added = ok(doc, 'add_stress_restraint', {
      modelId: id,
      at: { pipeId, atMm: 3000 },
      kind: 'translational',
      axis: 'y',
      oneWay: '+',
      gapMm: 2,
    });
    const restraintId = (added.data as { restraintId: string }).restraintId;
    expect(restraintId).toMatch(/^rst-\d+\.\d+$/);
    expect(added.document.plant?.stress?.models[id]?.restraints[0]).toEqual({
      id: restraintId,
      at: { pipeId, atMm: 3000 },
      kind: 'translational',
      axis: 'y',
      oneWay: '+',
      gapMm: 2,
    });
    const removed = ok(added.document, 'delete_stress_restraint', { modelId: id, restraintId });
    expect(removed.document.plant?.stress?.models[id]?.restraints).toEqual([]);
    expectPure(doc, () => execute(doc, 'add_stress_restraint', { modelId: id, at: { pipeId, atMm: 0 }, kind: 'anchor' }));
  });

  it('refuses malformed placements and parameter combinations with codes', () => {
    const { doc, id, pipeId } = scene();
    const at = { pipeId, atMm: 1000 };
    expectRefusal(doc, 'add_stress_restraint', { modelId: id, at, kind: 'translational' }, 'PST_PARAM_INVALID', 'axis');
    expectRefusal(doc, 'add_stress_restraint', { modelId: id, at, kind: 'rest', axis: 'z' }, 'PST_PARAM_INVALID', 'axis');
    expectRefusal(doc, 'add_stress_restraint', { modelId: id, at, kind: 'anchor', gapMm: 1 }, 'PST_PARAM_INVALID', 'gapMm');
    expectRefusal(
      doc,
      'add_stress_restraint',
      { modelId: id, at: { pipeId: 'ghost', atMm: 0 }, kind: 'anchor' },
      'PST_POINT_OFF_PIPE',
      'at.pipeId',
    );
    expectRefusal(
      doc,
      'add_stress_restraint',
      { modelId: id, at: { supportId: 'ghost' }, kind: 'anchor' },
      'PST_SUPPORT_NOT_FOUND',
      'at.supportId',
    );
    expectRefusal(doc, 'add_stress_restraint', { modelId: 'ghost', at, kind: 'anchor' }, 'PST_MODEL_NOT_FOUND');
    expectRefusal(doc, 'delete_stress_restraint', { modelId: id, restraintId: 'ghost' }, 'PST_PARAM_INVALID', 'restraintId');
    expectRefusal(doc, 'delete_stress_restraint', { modelId: 'ghost', restraintId: 'x' }, 'PST_MODEL_NOT_FOUND');
  });

  it('a restraint placed at a pipe support (supportId) maps to the node of that support', () => {
    const { doc, id, pipeId } = scene();
    const supported = apply(doc, 'add_pipe_support', { pipeId, at: [[3000, 0, 3000]], type: 'shoe' });
    const supportId = Object.values(supported.building?.elements ?? {}).find((element) => element.category === 'pipeSupport')?.id as string;
    const added = apply(supported, 'add_stress_restraint', { modelId: id, at: { supportId }, kind: 'translational', axis: 'y' });
    let ready = conditioned(added, id);
    ready = anchorAt(ready, id, pipeId, 0);
    ready = cases(ready, id, [{ name: 'W', type: 'SUS', basic: ['W'] }]);
    const result = analyzed(ready, id, { include: ['reactions'] });
    expect(result.model.nodes).toBe(3);
    expect(result.details?.reactions?.some((load) => load.supportIds.includes(supportId))).toBe(true);
  });
});

describe('analyze_pipe_stress refusals', () => {
  it('names the missing piece with a code: model, conditions, load cases, wall, mechanism', () => {
    const { doc, id, pipeId } = scene();
    expectRefusal(doc, 'analyze_pipe_stress', { modelId: 'ghost' }, 'PST_MODEL_NOT_FOUND');
    expectRefusal(doc, 'analyze_pipe_stress', { modelId: id }, 'PST_CONDITIONS_MISSING');
    const noWall = conditioned(doc, id, { wallMm: undefined });
    expectRefusal(noWall, 'analyze_pipe_stress', { modelId: id }, 'PST_WALL_UNKNOWN');
    const ready = conditioned(doc, id);
    expectRefusal(ready, 'analyze_pipe_stress', { modelId: id }, 'PST_LOADCASE_INVALID');
    const loaded = cases(ready, id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    const mechanism = expectRefusal(loaded, 'analyze_pipe_stress', { modelId: id }, 'PST_UNSTABLE');
    expect(mechanism.error?.ids.length).toBeGreaterThan(0);
    expect(mechanism.error?.paths.length).toBeGreaterThan(0);
    // a thermal primitive that the conditions do not define
    const anchored = anchorAt(anchorAt(loaded, id, pipeId, 0), id, pipeId, 6000);
    expectRefusal(
      cases(anchored, id, [{ name: 'S', type: 'OPE', basic: ['T2'] }]),
      'analyze_pipe_stress',
      { modelId: id },
      'PST_LOADCASE_INVALID',
    );
    expectRefusal(
      cases(anchored, id, [{ name: 'S', type: 'OPE', basic: ['P1'] }]),
      'analyze_pipe_stress',
      { modelId: id },
      'PST_LOADCASE_INVALID',
    );
  });

  it('refuses a pipe that was deleted since the model was made, and a pipe that is not a physical section', () => {
    const { doc, id, pipeId } = scene();
    const ready = cases(conditioned(doc, id), id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    const gone = apply(ready, 'delete_building_element', { elementIds: [pipeId] });
    const refusal = expectRefusal(gone, 'analyze_pipe_stress', { modelId: id }, 'PST_PIPE_NOT_FOUND');
    expect(refusal.error?.ids).toEqual([pipeId]);
    expectRefusal(conditioned(doc, id, { wallMm: 60 }), 'analyze_pipe_stress', { modelId: id }, 'PST_WALL_UNKNOWN');
  });

  it('a model of two separate pipe systems is analysed with the PST_DISCONNECTED warning', () => {
    const { doc, id, pipeId } = scene();
    const second = withPipe(
      doc,
      [
        [0, 4000, 3000],
        [3000, 4000, 3000],
      ],
      DN100.odMm,
    );
    let d = apply(second.doc, 'update_stress_model', { modelId: id, pipeIds: [pipeId, second.id] });
    d = conditioned(d, id);
    for (const [pipe, at] of [
      [pipeId, 0],
      [second.id, 0],
    ] as const)
      d = anchorAt(d, id, pipe, at);
    d = cases(d, id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    const result = analyzed(d, id);
    expect(result.findings.map((finding) => finding.code)).toContain('PST_DISCONNECTED');
    expect(result.model.pipes).toEqual([pipeId, second.id]);
  });

  it('is deterministic and read-only: the same document gives identical data twice', () => {
    const { doc, id, pipeId } = scene();
    const ready = cases(anchorAt(conditioned(doc, id), id, pipeId, 0), id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    const first = analyzed(ready, id, { include: ['stresses'] });
    expectPure(ready, () => analyzed(ready, id));
    expect(analyzed(ready, id, { include: ['stresses'] })).toEqual(first);
    expect(data(ready, 'analyze_pipe_stress', { modelId: id })).toMatchObject({ reviewRequired: true });
  });
});
