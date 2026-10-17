import { describe, expect, it } from 'vitest';
import type { execute } from '@core/commands/registry';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { caseIn, modelWithAnalysis, run } from './helpers';

function expectRefused(result: ReturnType<typeof execute>, doc: unknown, code: string): void {
  expectNoOp(result, doc);
  expect(result.rejected).toBe(true);
  expect(result.error?.code).toBe(code);
  expect(result.summary).toContain(code);
}

describe('FEA constraints', () => {
  it('adds fixed and displacement constraints with step-scoped ids and stores targets as given', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const fixed = run(doc, 'add_fea_constraint', {
      analysisId,
      name: 'base',
      kind: 'fixed',
      target: { entityId: boxId, facesNear: [[5, 5, 0]] },
    });
    const id = fixed.affected[0] ?? '';
    expect(id).toMatch(/^fc-\d+\.1$/);
    expect(caseIn(fixed.document, analysisId).constraints[id]).toEqual({
      id,
      name: 'base',
      kind: 'fixed',
      target: { entityId: boxId, facesNear: [[5, 5, 0]] },
    });
    expect(caseIn(fixed.document, analysisId).constraintOrder).toEqual([id]);
    const disp = run(fixed.document, 'add_fea_constraint', {
      analysisId,
      name: 'slide',
      kind: 'displacement',
      dofs: { uz: 0, ux: 0.5 },
      target: { entityId: boxId, edgesNear: [[0, 0, 5]] },
    });
    expect(caseIn(disp.document, analysisId).constraints[disp.affected[0] ?? '']?.dofs).toEqual({ uz: 0, ux: 0.5 });
    expect(caseIn(disp.document, analysisId).constraintOrder).toHaveLength(2);
    expectPure(doc, () =>
      run(doc, 'add_fea_constraint', { analysisId, name: 'b', kind: 'fixed', target: { entityId: boxId, facesNear: [[5, 5, 0]] } }),
    );
  });

  it('refuses unknown analysis, unresolvable targets, parts outside the analysis and bad dofs', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const base = { analysisId, name: 'c', kind: 'fixed' };
    const target = { entityId: boxId, facesNear: [[0, 0, 0]] };
    expectRefused(run(doc, 'add_fea_constraint', { ...base, analysisId: 'x', target }), doc, 'FEA_ANALYSIS_NOT_FOUND');
    expectRefused(
      run(doc, 'add_fea_constraint', { ...base, target: { entityId: 'ghost', facesNear: [[0, 0, 0]] } }),
      doc,
      'FEA_TARGET_UNRESOLVED',
    );
    expectRefused(run(doc, 'add_fea_constraint', { ...base, target: { entityId: boxId } }), doc, 'FEA_TARGET_UNRESOLVED');
    expectRefused(run(doc, 'add_fea_constraint', { ...base, target: { entityId: boxId, facesNear: [] } }), doc, 'FEA_TARGET_UNRESOLVED');
    const rect = run(doc, 'draw_rectangle', { corner: [0, 0], width: 5, height: 5 });
    expectRefused(
      run(rect.document, 'add_fea_constraint', { ...base, target: { entityId: rect.affected[0], pointsNear: [[0, 0, 0]] } }),
      rect.document,
      'FEA_TARGET_UNRESOLVED',
    );
    const other = run(doc, 'add_box', { size: [1, 1, 1] });
    expectRefused(
      run(other.document, 'add_fea_constraint', { ...base, target: { entityId: other.affected[0], facesNear: [[0, 0, 0]] } }),
      other.document,
      'FEA_PART_NOT_IN_ANALYSIS',
    );
    expectRefused(run(doc, 'add_fea_constraint', { ...base, kind: 'displacement', target }), doc, 'FEA_CONSTRAINT_INVALID');
    expectRefused(run(doc, 'add_fea_constraint', { ...base, kind: 'displacement', dofs: {}, target }), doc, 'FEA_CONSTRAINT_INVALID');
    expectRefused(run(doc, 'add_fea_constraint', { ...base, dofs: { ux: 0 }, target }), doc, 'FEA_CONSTRAINT_INVALID');
  });

  it('updates and deletes constraints', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const added = run(doc, 'add_fea_constraint', {
      analysisId,
      name: 'slide',
      kind: 'displacement',
      dofs: { uz: 0 },
      target: { entityId: boxId, facesNear: [[5, 5, 0]] },
    });
    const constraintId = added.affected[0] ?? '';
    const updated = run(added.document, 'update_fea_constraint', {
      analysisId,
      constraintId,
      name: 'renamed',
      dofs: { ux: 0 },
      target: { entityId: boxId, facesNear: [[0, 5, 5]] },
    });
    expect(updated.affected).toEqual([constraintId]);
    expect(caseIn(updated.document, analysisId).constraints[constraintId]).toMatchObject({
      name: 'renamed',
      kind: 'displacement',
      dofs: { ux: 0 },
      target: { facesNear: [[0, 5, 5]] },
    });
    expectPure(added.document, () => run(added.document, 'update_fea_constraint', { analysisId, constraintId, name: 'q' }));
    const removed = run(updated.document, 'delete_fea_constraint', { analysisId, constraintId });
    expect(removed.affected).toEqual([constraintId]);
    expect(caseIn(removed.document, analysisId).constraintOrder).toEqual([]);
    expect(caseIn(removed.document, analysisId).constraints).toEqual({});
  });

  it('refuses updates and deletes of unknown ids or invalid results', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const added = run(doc, 'add_fea_constraint', {
      analysisId,
      name: 'b',
      kind: 'fixed',
      target: { entityId: boxId, facesNear: [[5, 5, 0]] },
    });
    const constraintId = added.affected[0] ?? '';
    const withConstraint = added.document;
    expectRefused(
      run(withConstraint, 'update_fea_constraint', { analysisId: 'x', constraintId, name: 'n' }),
      withConstraint,
      'FEA_ANALYSIS_NOT_FOUND',
    );
    expectRefused(
      run(withConstraint, 'update_fea_constraint', { analysisId, constraintId: 'nope', name: 'n' }),
      withConstraint,
      'FEA_CONSTRAINT_NOT_FOUND',
    );
    expectRefused(
      run(withConstraint, 'update_fea_constraint', { analysisId, constraintId, dofs: { ux: 0 } }),
      withConstraint,
      'FEA_CONSTRAINT_INVALID',
    );
    expectRefused(
      run(withConstraint, 'delete_fea_constraint', { analysisId: 'x', constraintId }),
      withConstraint,
      'FEA_ANALYSIS_NOT_FOUND',
    );
    expectRefused(
      run(withConstraint, 'delete_fea_constraint', { analysisId, constraintId: 'nope' }),
      withConstraint,
      'FEA_CONSTRAINT_NOT_FOUND',
    );
  });
});

describe('FEA loads', () => {
  it('adds force, pressure and gravity loads with only the fields their kind uses', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const target = { entityId: boxId, facesNear: [[5, 5, 10]] };
    const force = run(doc, 'add_fea_load', { analysisId, name: 'tip', kind: 'force', vector: [0, 0, -500], target });
    const forceId = force.affected[0] ?? '';
    expect(forceId).toMatch(/^fl-\d+\.1$/);
    expect(caseIn(force.document, analysisId).loads[forceId]).toEqual({
      id: forceId,
      name: 'tip',
      loadCase: 'LC1',
      category: 'limit',
      kind: 'force',
      target,
      vector: [0, 0, -500],
      distribution: 'total',
    });
    const pressure = run(force.document, 'add_fea_load', {
      analysisId,
      name: 'p',
      kind: 'pressure',
      magnitude: 2,
      target,
      loadCase: 'LC2',
      category: 'ultimate',
    });
    expect(caseIn(pressure.document, analysisId).loads[pressure.affected[0] ?? '']).toMatchObject({
      kind: 'pressure',
      magnitude: 2,
      loadCase: 'LC2',
      category: 'ultimate',
    });
    const gravity = run(pressure.document, 'add_fea_load', { analysisId, name: 'g', kind: 'gravity', vector: [0, 0, -9810] });
    const gravityLoad = caseIn(gravity.document, analysisId).loads[gravity.affected[0] ?? ''];
    expect(gravityLoad?.target).toBeUndefined();
    expect(caseIn(gravity.document, analysisId).loadOrder).toHaveLength(3);
    expectPure(doc, () => run(doc, 'add_fea_load', { analysisId, name: 'g', kind: 'gravity', vector: [0, 0, -1] }));
  });

  it('refuses bad loads', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const target = { entityId: boxId, facesNear: [[5, 5, 10]] };
    const base = { analysisId, name: 'l' };
    expectRefused(
      run(doc, 'add_fea_load', { ...base, analysisId: 'x', kind: 'gravity', vector: [0, 0, -1] }),
      doc,
      'FEA_ANALYSIS_NOT_FOUND',
    );
    expectRefused(run(doc, 'add_fea_load', { ...base, kind: 'force', target }), doc, 'FEA_LOAD_INVALID');
    expectRefused(run(doc, 'add_fea_load', { ...base, kind: 'force', vector: [0, 0, 0], target }), doc, 'FEA_LOAD_INVALID');
    expectRefused(run(doc, 'add_fea_load', { ...base, kind: 'force', vector: [0, 0, 1] }), doc, 'FEA_LOAD_INVALID');
    expectRefused(
      run(doc, 'add_fea_load', { ...base, kind: 'force', vector: [0, 0, 1], target: { entityId: 'ghost', facesNear: [[0, 0, 0]] } }),
      doc,
      'FEA_TARGET_UNRESOLVED',
    );
    expectRefused(run(doc, 'add_fea_load', { ...base, kind: 'pressure', target }), doc, 'FEA_LOAD_INVALID');
    expectRefused(run(doc, 'add_fea_load', { ...base, kind: 'pressure', magnitude: 0, target }), doc, 'FEA_LOAD_INVALID');
    expectRefused(
      run(doc, 'add_fea_load', { ...base, kind: 'pressure', magnitude: 1, vector: [0, 0, 1], target }),
      doc,
      'FEA_LOAD_INVALID',
    );
    expectRefused(run(doc, 'add_fea_load', { ...base, kind: 'gravity' }), doc, 'FEA_LOAD_INVALID');
    expectRefused(run(doc, 'add_fea_load', { ...base, kind: 'gravity', vector: [0, 0, -1], target }), doc, 'FEA_LOAD_INVALID');
    expectRefused(run(doc, 'add_fea_load', { ...base, kind: 'gravity', vector: [0, 0, -1], loadCase: ' ' }), doc, 'FEA_LOAD_INVALID');
    expect(run(doc, 'add_fea_load', { ...base, kind: 'moment', vector: [0, 0, 1], target }).summary).toContain('invalid params');
  });

  it('updates and deletes loads', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const target = { entityId: boxId, facesNear: [[5, 5, 10]] };
    const added = run(doc, 'add_fea_load', { analysisId, name: 'tip', kind: 'force', vector: [0, 0, -500], target });
    const loadId = added.affected[0] ?? '';
    const updated = run(added.document, 'update_fea_load', {
      analysisId,
      loadId,
      name: 'tip2',
      loadCase: 'LC3',
      category: 'ultimate',
      vector: [0, 0, -700],
      distribution: 'per_node',
      target: { entityId: boxId, facesNear: [[1, 1, 10]] },
    });
    expect(caseIn(updated.document, analysisId).loads[loadId]).toMatchObject({
      name: 'tip2',
      loadCase: 'LC3',
      category: 'ultimate',
      vector: [0, 0, -700],
      distribution: 'per_node',
      target: { facesNear: [[1, 1, 10]] },
    });
    expectPure(added.document, () => run(added.document, 'update_fea_load', { analysisId, loadId, name: 'q' }));
    const pressure = run(updated.document, 'add_fea_load', { analysisId, name: 'p', kind: 'pressure', magnitude: 1, target });
    const pressureId = pressure.affected[0] ?? '';
    const changedMagnitude = run(pressure.document, 'update_fea_load', { analysisId, loadId: pressureId, magnitude: 4 });
    expect(caseIn(changedMagnitude.document, analysisId).loads[pressureId]?.magnitude).toBe(4);
    const removed = run(changedMagnitude.document, 'delete_fea_load', { analysisId, loadId });
    expect(removed.affected).toEqual([loadId]);
    expect(caseIn(removed.document, analysisId).loadOrder).toEqual([pressureId]);
    expect(Object.keys(caseIn(removed.document, analysisId).loads)).toEqual([pressureId]);
  });

  it('refuses updates and deletes of unknown ids, unused fields and invalid results', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const target = { entityId: boxId, facesNear: [[5, 5, 10]] };
    const added = run(doc, 'add_fea_load', { analysisId, name: 'tip', kind: 'force', vector: [0, 0, -500], target });
    const loadId = added.affected[0] ?? '';
    const withLoad = added.document;
    expectRefused(run(withLoad, 'update_fea_load', { analysisId: 'x', loadId, name: 'n' }), withLoad, 'FEA_ANALYSIS_NOT_FOUND');
    expectRefused(run(withLoad, 'update_fea_load', { analysisId, loadId: 'nope', name: 'n' }), withLoad, 'FEA_LOAD_NOT_FOUND');
    expectRefused(run(withLoad, 'update_fea_load', { analysisId, loadId, magnitude: 3 }), withLoad, 'FEA_LOAD_INVALID');
    expectRefused(run(withLoad, 'update_fea_load', { analysisId, loadId, loadCase: '' }), withLoad, 'FEA_LOAD_INVALID');
    expectRefused(run(withLoad, 'update_fea_load', { analysisId, loadId, vector: [0, 0, 0] }), withLoad, 'FEA_LOAD_INVALID');
    expectRefused(run(withLoad, 'delete_fea_load', { analysisId: 'x', loadId }), withLoad, 'FEA_ANALYSIS_NOT_FOUND');
    expectRefused(run(withLoad, 'delete_fea_load', { analysisId, loadId: 'nope' }), withLoad, 'FEA_LOAD_NOT_FOUND');
    const moment = {
      ...withLoad,
      analysis: {
        ...withLoad.analysis!,
        cases: {
          ...withLoad.analysis!.cases,
          [analysisId]: {
            ...caseIn(withLoad, analysisId),
            loads: { [loadId]: { ...caseIn(withLoad, analysisId).loads[loadId]!, kind: 'moment' as const } },
          },
        },
      },
    };
    expectRefused(run(moment, 'update_fea_load', { analysisId, loadId, name: 'n' }), moment, 'FEA_LOAD_INVALID');
  });
});
