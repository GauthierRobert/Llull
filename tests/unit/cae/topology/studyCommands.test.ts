import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { readPlan, code, mbbModel, solveAndRecord, studyOf } from './support';

const run = (model: ReturnType<typeof mbbModel>, name: string, params: Record<string, unknown>): ReturnType<typeof execute> =>
  execute(model.doc, name, { studyId: model.studyId, ...params });

describe('create_topology_study', () => {
  const base = mbbModel();
  const create = (params: Record<string, unknown>): ReturnType<typeof execute> =>
    execute(base.doc, 'create_topology_study', {
      analysisId: base.analysisId,
      name: 'second',
      designDomain: [base.entityId],
      dimension: 2,
      voxel: 2,
      volumeFraction: 0.4,
      ...params,
    });

  it('adds a study with named defaults and ids ts-<step>.<k>', () => {
    const before = JSON.stringify(base.doc);
    const result = create({});
    expect(JSON.stringify(base.doc)).toBe(before);
    const id = result.affected[0] ?? '';
    expect(id).toMatch(/^ts-\d+\.\d+$/);
    expect(result.affected).toEqual([id]);
    const study = result.document.analysis?.cases[base.analysisId]?.topology?.[id];
    expect(study).toMatchObject({ dimension: 2, plane: 'XY', voxel: 2, volumeFraction: 0.4, keepIn: [], keepOut: [] });
    expect(study?.settings.penal).toEqual({ value: 3, source: expect.stringContaining('Andreassen'), defaulted: true });
    expect(study?.settings.filter.radius.value).toBe(3);
    expect(study?.settings.protectLoadSupport.value).toBe(true);
    expect(result.document.analysis?.cases[base.analysisId]?.topologyOrder).toEqual([base.studyId, id]);
    expect(result.summary).toContain('30 x 10 = 300 voxels of 2 mm');
    expect(result.summary).toContain('named defaults');
  });

  it('creates a 3D study without a plane and weighs load cases', () => {
    const result = create({ dimension: 3, voxel: 5, objective: { kind: 'min_compliance', loadCaseWeights: { LC1: 2 } } });
    const study = result.document.analysis?.cases[base.analysisId]?.topology?.[result.affected[0] ?? ''];
    expect(study?.dimension).toBe(3);
    expect(study?.plane).toBeUndefined();
    expect(study?.objective.loadCaseWeights).toEqual({ LC1: 2 });
    expect(result.summary).toContain('12 x 4 x 1 = 48 voxels');
  });

  it.each([
    ['unknown analysis', { analysisId: 'an-0.0' }, 'TOP_ANALYSIS_MISSING'],
    ['volumeFraction 1', { volumeFraction: 1 }, 'TOP_VOLUME_FRACTION_INVALID'],
    ['volumeFraction 0', { volumeFraction: 0 }, 'TOP_VOLUME_FRACTION_INVALID'],
    ['voxel 0', { voxel: 0 }, 'TOP_SETUP_INVALID'],
    ['plane on a 3D study', { dimension: 3, plane: 'XY' }, 'TOP_SETUP_INVALID'],
    ['weight 0', { objective: { kind: 'min_compliance', loadCaseWeights: { LC1: 0 } } }, 'TOP_SETUP_INVALID'],
    ['empty domain', { designDomain: [] }, 'TOP_DOMAIN_INVALID'],
    ['entity that is not a part', { designDomain: ['nope'] }, 'TOP_DOMAIN_INVALID'],
    ['too many voxels', { voxel: 0.01 }, 'TOP_GRID_TOO_LARGE'],
  ])('refuses %s without changing the document', (_name, params, expected) => {
    const result = create(params);
    expect(code(result)).toBe(expected);
    expect(result.document).toBe(base.doc);
    expect(result.affected).toEqual([]);
    expect(result.rejected).toBe(true);
  });

  it('refuses a part that is not a solid and suggests a voxel size for a grid that is too large', () => {
    const big = create({ voxel: 0.01 });
    expect(big.summary).toMatch(/use voxel >= \d/);
    const sketch = execute(base.doc, 'draw_rectangle', { width: 5, height: 5 });
    const id = sketch.affected[0] ?? '';
    const asPart = execute(sketch.document, 'set_part_idealization', { analysisId: base.analysisId, entityId: id, idealization: 'solid' });
    expect(asPart.affected).toEqual([]);
    expect(code(create({ designDomain: [id] }))).toBe('TOP_DOMAIN_INVALID');
  });

  it('rejects a document without the analysis slice', () => {
    expect(
      code(
        execute(execute(base.doc, 'delete_topology_study', { studyId: base.studyId }).document, 'set_topology_regions', {
          studyId: base.studyId,
          keepIn: [],
        }),
      ),
    ).toBe('TOP_STUDY_NOT_FOUND');
  });
});

describe('set_topology_regions', () => {
  const model = mbbModel();
  const box = (min: number[], max: number[]): Record<string, unknown> => ({ kind: 'box', min, max });

  it('replaces the given lists and reports voxel counts and the budget', () => {
    const before = JSON.stringify(model.doc);
    const result = run(model, 'set_topology_regions', { keepIn: [box([0, 0, 0], [10, 20, 1])], keepOut: [box([30, 5, 0], [40, 10, 1])] });
    expect(JSON.stringify(model.doc)).toBe(before);
    expect(result.affected).toEqual([model.studyId]);
    expect(result.summary).toContain('1 keep-in region(s) = 200 voxels');
    expect(result.summary).toContain('1 keep-out region(s) = 50 voxels of 1200 active; budget 600');
    const study = studyOf(result.document, model.analysisId, model.studyId);
    expect(study.keepIn).toEqual([{ kind: 'box', min: [0, 0, 0], max: [10, 20, 1] }]);
    const kept = execute(result.document, 'set_topology_regions', { studyId: model.studyId, keepOut: [] });
    expect(studyOf(kept.document, model.analysisId, model.studyId).keepIn).toHaveLength(1);
    expect(studyOf(kept.document, model.analysisId, model.studyId).keepOut).toEqual([]);
  });

  it('accepts entity and target regions', () => {
    const result = run(model, 'set_topology_regions', { keepIn: [{ kind: 'entity', entityId: model.entityId }], keepOut: [] });
    expect(code(result)).toBe('TOP_KEEPIN_EXCEEDS_BUDGET');
    const target = run(model, 'set_topology_regions', {
      keepIn: [{ kind: 'target', target: { entityId: model.entityId, edgesNear: [[0, 10, 0]] }, depthVoxels: 2 }],
    });
    expect(target.summary).toContain('= 40 voxels');
    const defaulted = run(model, 'set_topology_regions', {
      keepIn: [{ kind: 'target', target: { entityId: model.entityId, pointsNear: [[0, 20, 0]] } }],
    });
    expect(studyOf(defaulted.document, model.analysisId, model.studyId).keepIn).toEqual([
      { kind: 'target', target: { entityId: model.entityId, pointsNear: [[0, 20, 0]] }, depthVoxels: 1 },
    ]);
  });

  it.each([
    ['a box outside the domain', { keepIn: [box([100, 0, 0], [110, 5, 1])] }, 'TOP_REGION_OUTSIDE_DOMAIN'],
    ['a box off the slab of a 2D study', { keepOut: [box([0, 0, 5], [10, 5, 6])] }, 'TOP_REGION_OUTSIDE_DOMAIN'],
    ['an unknown entity', { keepOut: [{ kind: 'entity', entityId: 'nope' }] }, 'TOP_REGION_OUTSIDE_DOMAIN'],
    [
      'a target that maps to no node',
      { keepIn: [{ kind: 'target', target: { entityId: model.entityId, pointsNear: [[500, 500, 0]] } }] },
      'TOP_REGION_OUTSIDE_DOMAIN',
    ],
    ['keep-in over the volume budget (VC-TOP-24)', { keepIn: [box([0, 0, 0], [40, 20, 1])] }, 'TOP_KEEPIN_EXCEEDS_BUDGET'],
    [
      'overlapping keep-in and keep-out',
      { keepIn: [box([0, 0, 0], [10, 10, 1])], keepOut: [box([5, 5, 0], [15, 15, 1])] },
      'TOP_SETUP_INVALID',
    ],
    ['no list', {}, 'TOP_SETUP_INVALID'],
  ])('refuses %s', (_name, params, expected) => {
    const result = run(model, 'set_topology_regions', params);
    expect(code(result)).toBe(expected);
    expect(result.document).toBe(model.doc);
    expect(result.affected).toEqual([]);
  });

  it('refuses an unknown study', () => {
    expect(code(execute(model.doc, 'set_topology_regions', { studyId: 'ts-0.0', keepIn: [] }))).toBe('TOP_STUDY_NOT_FOUND');
  });

  it('reproduces the rejection plan of the validation pack (VC-TOP-24)', () => {
    const actions = readPlan('top_rejection_keepin_budget').map((action) =>
      action.command === 'set_part_idealization'
        ? { ...action, params: { analysisId: action.params['analysisId'], entityId: action.params['entityId'], idealization: 'solid' } }
        : action,
    );
    const outcome = execute(createEmptyDocument(), 'build_project', { actions });
    const steps = (outcome.data as { steps: Array<{ ok: boolean; command: string; summary: string }> }).steps;
    const last = steps[steps.length - 1];
    expect(last?.command).toBe('set_topology_regions');
    expect(last?.ok).toBe(false);
    expect(last?.summary).toContain('TOP_KEEPIN_EXCEEDS_BUDGET');
  });
});

describe('set_topology_settings', () => {
  const model = mbbModel();

  it('changes only the given values and stores them as chosen', () => {
    const before = JSON.stringify(model.doc);
    const result = run(model, 'set_topology_settings', {
      penal: 4,
      maxIterations: 50,
      filter: { kind: 'density', radius: 2.5 },
      protectLoadSupport: true,
      threshold: 0.4,
      greyLimit: 0.2,
      manufacturing: { symmetry: ['XZ', 'XZ'] },
    });
    expect(JSON.stringify(model.doc)).toBe(before);
    const study = studyOf(result.document, model.analysisId, model.studyId);
    expect(study.settings.penal).toEqual({ value: 4, source: 'set_topology_settings', defaulted: false });
    expect(study.settings.move.defaulted).toBe(false);
    expect(study.settings.filter).toEqual({ kind: 'density', radius: { value: 2.5, source: 'set_topology_settings', defaulted: false } });
    expect(study.settings.protectLoadSupport).toEqual({ value: true, source: 'set_topology_settings', defaulted: false });
    expect(study.manufacturing.symmetry).toEqual(['XZ']);
    expect(result.affected).toEqual([model.studyId]);
    expect(result.summary).toContain('density filter radius 2.5 mm');
  });

  it('keeps the other settings and warns about a filter radius below one voxel', () => {
    const result = run(model, 'set_topology_settings', { filter: { radius: 0.5 }, eminRatio: 1e-6, move: 0.5, changeTol: 0.001 });
    const study = studyOf(result.document, model.analysisId, model.studyId);
    expect(study.settings.filter.kind).toBe('sensitivity');
    expect(study.settings.eminRatio.value).toBe(1e-6);
    expect(result.summary).toContain('TOP_FILTER_TOO_SMALL');
    expect(studyOf(result.document, model.analysisId, model.studyId).settings.penal.value).toBe(3);
  });

  it.each([
    ['penal 6', { penal: 6 }],
    ['penal 0.5', { penal: 0.5 }],
    ['eminRatio 1', { eminRatio: 1 }],
    ['move 0', { move: 0 }],
    ['changeTol 0', { changeTol: 0 }],
    ['maxIterations 0', { maxIterations: 0 }],
    ['filter radius -1', { filter: { radius: -1 } }],
    ['threshold 1', { threshold: 1 }],
    ['greyLimit 0', { greyLimit: 0 }],
    ['optimizer mma', { optimizer: 'mma' }],
    ['no value', {}],
    ['an unchanged value', { penal: 3 }],
  ])('refuses %s', (name, params) => {
    const result = run(
      model,
      'set_topology_settings',
      name === 'an unchanged value' ? { penal: 3, filter: { kind: 'sensitivity' } } : params,
    );
    const settingsAfter = name === 'an unchanged value' ? result.document : model.doc;
    expect(code(result)).toBe('TOP_SETUP_INVALID');
    expect(result.document).toBe(settingsAfter === result.document ? result.document : model.doc);
    expect(result.affected).toEqual([]);
  });

  it('refuses an unknown study', () => {
    expect(code(execute(model.doc, 'set_topology_settings', { studyId: 'ts-0.0', penal: 3 }))).toBe('TOP_STUDY_NOT_FOUND');
  });
});

describe('delete_topology_study', () => {
  it('removes the study and its iso-surface entity', () => {
    const model = mbbModel();
    const solved = solveAndRecord(model);
    const derivedId = studyOf(solved.doc, model.analysisId, model.studyId).derivedEntityId ?? '';
    expect(solved.doc.entities[derivedId]).toBeDefined();
    const before = JSON.stringify(solved.doc);
    const result = execute(solved.doc, 'delete_topology_study', { studyId: model.studyId });
    expect(JSON.stringify(solved.doc)).toBe(before);
    expect(result.affected).toEqual([model.studyId, derivedId]);
    expect(result.document.entities[derivedId]).toBeUndefined();
    expect(result.document.order).not.toContain(derivedId);
    expect(result.document.analysis?.cases[model.analysisId]?.topology).toEqual({});
    expect(result.document.analysis?.cases[model.analysisId]?.topologyOrder).toEqual([]);
    expect(result.summary).toContain(derivedId);
  });

  it('removes an unsolved study alone and refuses an unknown one', () => {
    const model = mbbModel();
    const result = execute(model.doc, 'delete_topology_study', { studyId: model.studyId });
    expect(result.affected).toEqual([model.studyId]);
    const again = execute(result.document, 'delete_topology_study', { studyId: model.studyId });
    expect(code(again)).toBe('TOP_STUDY_NOT_FOUND');
    expect(again.document).toBe(result.document);
  });
});
