import { describe, expect, it } from 'vitest';
import type { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { addResultProbe } from '@cae/commands/probes';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { caseIn, modelWithAnalysis, run } from './helpers';

const empty = createEmptyDocument();

function expectRefused(result: ReturnType<typeof execute>, doc: unknown, code: string): void {
  expectNoOp(result, doc);
  expect(result.rejected).toBe(true);
  expect(result.error?.code).toBe(code);
  expect(result.error?.remediation).not.toBe('');
  expect(result.summary).toContain(code);
}

describe('create_analysis', () => {
  it('creates a static case with step-scoped id, unit system from the document and named defaults', () => {
    const result = run(empty, 'create_analysis', { name: 'bracket', analysisType: 'static' });
    expect(result.affected).toEqual(['an-1.1']);
    const analysisCase = caseIn(result.document, 'an-1.1');
    expect(analysisCase).toMatchObject({
      type: 'static',
      solver: 'calculix',
      unitSystem: 'N-mm-t-s',
      factors: { ultimate: 1.5, yield: 1 },
    });
    expect(analysisCase.thermal).toBeUndefined();
    expect(analysisCase.mesh).toMatchObject({ order: 2, elementFamily: 'tet', globalSize: 10 });
    expect(result.document.analysis?.caseOrder).toEqual(['an-1.1']);
    expect(result.summary).toContain('N-mm-t-s');
  });

  it('is pure and ids are deterministic per step', () => {
    expectPure(empty, () => run(empty, 'create_analysis', { name: 'a', analysisType: 'static' }));
    const first = run(empty, 'create_analysis', { name: 'a', analysisType: 'static' });
    const second = run(first.document, 'create_analysis', { name: 'b', analysisType: 'heat_steady' });
    expect(second.affected).toEqual(['an-2.1']);
    expect(second.document.analysis?.caseOrder).toEqual(['an-1.1', 'an-2.1']);
    expect(run(empty, 'create_analysis', { name: 'a', analysisType: 'static' }).affected).toEqual(first.affected);
  });

  it('maps document units to unit systems', () => {
    for (const [unit, system] of [
      ['m', 'N-m-kg-s'],
      ['in', 'lbf-in-slinch-s'],
      ['cm', 'N-mm-t-s'],
    ] as const) {
      const doc = { ...empty, units: unit };
      const result = run(doc, 'create_analysis', { name: 'a', analysisType: 'static' });
      expect(caseIn(result.document, result.affected[0] ?? '').unitSystem).toBe(system);
    }
  });

  it('heat cases get an empty thermal setup with a named temperature scale', () => {
    const result = run(empty, 'create_analysis', { name: 'h', analysisType: 'heat_transient', temperatureScale: 'K' });
    const thermal = caseIn(result.document, 'an-1.1').thermal;
    expect(thermal).toMatchObject({ temperatureScale: 'K', bcOrder: [], limitOrder: [], step: {} });
    const defaulted = run(empty, 'create_analysis', { name: 'h', analysisType: 'heat_steady' });
    expect(caseIn(defaulted.document, 'an-1.1').thermal?.temperatureScale).toBe('degC');
    expect(defaulted.summary).toContain('degC (default)');
  });

  it('thermo_static records the reference temperature and load case', () => {
    const result = run(empty, 'create_analysis', {
      name: 't',
      analysisType: 'thermo_static',
      referenceTemperature: { value: 20, unit: 'degC' },
      loadCaseName: 'cooldown',
    });
    expect(caseIn(result.document, 'an-1.1').thermomech).toEqual({
      referenceTemperature: { value: 20, unit: 'degC' },
      temperatureScale: 'degC',
      loadCaseName: 'cooldown',
    });
    expect(caseIn(result.document, 'an-1.1').thermal).toBeUndefined();
  });

  it('accepts custom factors', () => {
    const result = run(empty, 'create_analysis', {
      name: 'f',
      analysisType: 'static',
      factors: { ultimate: 2, yield: 1, extra: [{ name: 'fitting', value: 1.15, justification: 'rule' }] },
    });
    expect(caseIn(result.document, 'an-1.1').factors).toEqual({
      ultimate: 2,
      yield: 1,
      extra: [{ name: 'fitting', value: 1.15, justification: 'rule' }],
    });
  });

  it('refuses mismatched units, missing reference temperature, bad units and factors', () => {
    expectRefused(
      run(empty, 'create_analysis', { name: 'a', analysisType: 'static', unitSystem: 'N-m-kg-s' }),
      empty,
      'FEA_UNITS_MISMATCH',
    );
    expectRefused(run(empty, 'create_analysis', { name: 'a', analysisType: 'thermo_static' }), empty, 'TMC_REFERENCE_TEMPERATURE_MISSING');
    expectRefused(
      run(empty, 'create_analysis', { name: 'a', analysisType: 'thermo_static', referenceTemperature: { value: 20, unit: 'mm' } }),
      empty,
      'THM_UNITS_MISMATCH',
    );
    expectRefused(
      run(empty, 'create_analysis', { name: 'a', analysisType: 'thermo_static', referenceTemperature: { value: 20, unit: 'bogus' } }),
      empty,
      'THM_UNITS_MISMATCH',
    );
    expectRefused(
      run(empty, 'create_analysis', { name: 'a', analysisType: 'static', temperatureScale: 'K' }),
      empty,
      'FEA_PARAM_NOT_APPLICABLE',
    );
    expectRefused(
      run(empty, 'create_analysis', { name: 'a', analysisType: 'heat_steady', referenceTemperature: { value: 1, unit: 'K' } }),
      empty,
      'FEA_PARAM_NOT_APPLICABLE',
    );
    expectRefused(
      run(empty, 'create_analysis', { name: 'a', analysisType: 'static', factors: { ultimate: 0.5, yield: 1 } }),
      empty,
      'FEA_FACTOR_INVALID',
    );
    expectRefused(
      run(empty, 'create_analysis', {
        name: 'a',
        analysisType: 'static',
        factors: { ultimate: 1.5, yield: 1, extra: [{ name: 'x', value: 1.2, justification: ' ' }] },
      }),
      empty,
      'FEA_FACTOR_INVALID',
    );
  });
});

describe('delete_analysis / describe_analysis', () => {
  it('deletes a case and refuses unknown ids', () => {
    const { doc, analysisId } = modelWithAnalysis();
    const result = run(doc, 'delete_analysis', { analysisId });
    expect(result.affected).toEqual([analysisId]);
    expect(result.document.analysis?.cases).toEqual({});
    expect(result.document.analysis?.caseOrder).toEqual([]);
    expectPure(doc, () => run(doc, 'delete_analysis', { analysisId }));
    expectRefused(run(doc, 'delete_analysis', { analysisId: 'nope' }), doc, 'FEA_ANALYSIS_NOT_FOUND');
    expect(run(doc, 'delete_analysis', { analysisId: 'constructor' }).rejected).toBe(true);
  });

  it('refuses to delete an analysis another case reads as its temperature field', () => {
    const { doc, analysisId } = modelWithAnalysis('heat_steady');
    const created = run(doc, 'create_analysis', {
      name: 't',
      analysisType: 'thermo_static',
      referenceTemperature: { value: 20, unit: 'degC' },
    });
    const consumerId = created.affected[0] ?? '';
    const consumer = caseIn(created.document, consumerId);
    const linked = {
      ...created.document,
      analysis: {
        ...created.document.analysis!,
        cases: {
          ...created.document.analysis!.cases,
          [consumerId]: {
            ...consumer,
            thermomech: {
              ...consumer.thermomech!,
              field: { kind: 'thermal_result' as const, analysisId, time: 'last' as const, mapping: 'same_mesh' as const },
            },
          },
        },
      },
    };
    const refused = run(linked, 'delete_analysis', { analysisId });
    expectRefused(refused, linked, 'FEA_ANALYSIS_IN_USE');
    expect(refused.error?.ids).toContain(consumerId);
  });

  it('lists analyses and describes one with states and input hashes', () => {
    const { doc, analysisId } = modelWithAnalysis();
    const list = run(doc, 'describe_analysis', {});
    expect(list.affected).toEqual([]);
    expect(list.document).toBe(doc);
    expect(list.data).toEqual({ analyses: [{ id: analysisId, name: 'A', type: 'static', state: 'unmeshed' }] });
    const one = run(doc, 'describe_analysis', { analysisId });
    const data = one.data as { state: string; inputHash: { mesh: string; full: string }; case: { id: string } };
    expect(data.state).toBe('unmeshed');
    expect(data.case.id).toBe(analysisId);
    expect(data.inputHash.mesh).toMatch(/^[0-9a-f]{64}$/);
    expect(data.inputHash.full).not.toBe(data.inputHash.mesh);
    expectRefused(run(doc, 'describe_analysis', { analysisId: 'zzz' }), doc, 'FEA_ANALYSIS_NOT_FOUND');
    expect(run(empty, 'describe_analysis', {}).data).toEqual({ analyses: [] });
  });
});

describe('set_part_idealization', () => {
  it('adds a solid part; setting it again is harmless', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    expect(caseIn(doc, analysisId).parts).toEqual({ [boxId]: { kind: 'solid' } });
    const again = run(doc, 'set_part_idealization', { analysisId, entityId: boxId, idealization: 'solid' });
    expect(again.affected).toEqual([analysisId]);
    expect(Object.keys(caseIn(again.document, analysisId).parts)).toEqual([boxId]);
    expectPure(doc, () => run(doc, 'set_part_idealization', { analysisId, entityId: boxId }));
  });

  it('refuses unknown analysis, missing and 2D entities and unbuilt idealizations', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const rect = run(doc, 'draw_rectangle', { position: [0, 0], width: 5, height: 5 });
    const rectId = rect.affected[0] ?? '';
    expect(rectId).not.toBe('');
    expectRefused(run(rect.document, 'set_part_idealization', { analysisId, entityId: rectId }), rect.document, 'FEA_PART_INVALID');
    expectRefused(run(doc, 'set_part_idealization', { analysisId: 'x', entityId: boxId }), doc, 'FEA_ANALYSIS_NOT_FOUND');
    expectRefused(run(doc, 'set_part_idealization', { analysisId, entityId: 'ghost' }), doc, 'FEA_PART_INVALID');
    expectRefused(
      run(doc, 'set_part_idealization', { analysisId, entityId: boxId, idealization: 'shell' }),
      doc,
      'FEA_MIDSURFACE_NOT_A_PLATE',
    );
  });
});

describe('set_mesh_controls', () => {
  it('merges the given fields and validates refinements against the parts', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const result = run(doc, 'set_mesh_controls', {
      analysisId,
      order: 1,
      globalSize: 2,
      minSize: 0.5,
      refinements: [{ target: { entityId: boxId, facesNear: [[0, 0, 5]] }, size: 1 }],
    });
    expect(result.affected).toEqual([analysisId]);
    expect(caseIn(result.document, analysisId).mesh).toMatchObject({
      order: 1,
      globalSize: 2,
      minSize: 0.5,
      elementFamily: 'tet',
      refinements: [{ target: { entityId: boxId, facesNear: [[0, 0, 5]] }, size: 1 }],
    });
    const partial = run(result.document, 'set_mesh_controls', { analysisId, optimize: 'none' });
    expect(caseIn(partial.document, analysisId).mesh).toMatchObject({ order: 1, globalSize: 2, minSize: 0.5, optimize: 'none' });
    expectPure(doc, () => run(doc, 'set_mesh_controls', { analysisId, globalSize: 3 }));
  });

  it('sets conformal bonding, stores "separate" as absent and keeps the choice on later edits', () => {
    const { doc, analysisId } = modelWithAnalysis();
    expect(caseIn(doc, analysisId).mesh.bonding).toBeUndefined();
    const conformal = run(doc, 'set_mesh_controls', { analysisId, bonding: 'conformal' });
    expect(caseIn(conformal.document, analysisId).mesh.bonding).toBe('conformal');
    expect(conformal.summary).toContain('conformal bonding');
    const finer = run(conformal.document, 'set_mesh_controls', { analysisId, globalSize: 2 });
    expect(caseIn(finer.document, analysisId).mesh.bonding).toBe('conformal');
    const back = run(finer.document, 'set_mesh_controls', { analysisId, bonding: 'separate' });
    expect('bonding' in caseIn(back.document, analysisId).mesh).toBe(false);
    expect(run(doc, 'set_mesh_controls', { analysisId, bonding: 'glued' }).summary).toContain('invalid params');
  });

  it('refuses inconsistent or unresolvable controls', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    expectRefused(run(doc, 'set_mesh_controls', { analysisId: 'x', globalSize: 1 }), doc, 'FEA_ANALYSIS_NOT_FOUND');
    expectRefused(run(doc, 'set_mesh_controls', { analysisId, globalSize: 1, minSize: 2 }), doc, 'FEA_MESH_CONTROLS_INVALID');
    expectRefused(
      run(doc, 'set_mesh_controls', {
        analysisId,
        globalSize: 1,
        refinements: [{ target: { entityId: boxId, facesNear: [[0, 0, 0]] }, size: 3 }],
      }),
      doc,
      'FEA_MESH_CONTROLS_INVALID',
    );
    expectRefused(
      run(doc, 'set_mesh_controls', { analysisId, refinements: [{ target: { entityId: 'ghost', facesNear: [[0, 0, 0]] }, size: 1 }] }),
      doc,
      'FEA_TARGET_UNRESOLVED',
    );
    expect(run(doc, 'set_mesh_controls', { analysisId, order: 3 }).summary).toContain('invalid params');
    expect(run(doc, 'set_mesh_controls', { analysisId, globalSize: 0 }).summary).toContain('invalid params');
  });
});

describe('result probes', () => {
  it('adds and deletes probes with step-scoped ids', () => {
    const { doc, analysisId } = modelWithAnalysis('heat_steady');
    const added = run(doc, 'add_result_probe', { analysisId, name: 'hot', point: [1, 2, 3], quantity: 'temperature' });
    const probeId = added.affected[0] ?? '';
    expect(probeId).toMatch(/^pr-\d+\.1$/);
    expect(caseIn(added.document, analysisId).probes[probeId]).toEqual({ name: 'hot', point: [1, 2, 3], quantity: 'temperature' });
    expectPure(doc, () => run(doc, 'add_result_probe', { analysisId, name: 'hot', point: [1, 2, 3], quantity: 'heat_flux' }));
    const removed = run(added.document, 'delete_analysis_item', { analysisId, itemId: probeId });
    expect(removed.affected).toEqual([probeId]);
    expect(caseIn(removed.document, analysisId).probes).toEqual({});
  });

  it('refuses unknown analysis, probe and unusable points or quantities', () => {
    const { doc, analysisId } = modelWithAnalysis();
    expectRefused(
      run(doc, 'add_result_probe', { analysisId: 'x', name: 'p', point: [0, 0, 0], quantity: 'u_mag' }),
      doc,
      'FEA_ANALYSIS_NOT_FOUND',
    );
    expectRefused(run(doc, 'delete_analysis_item', { analysisId: 'x', itemId: 'p' }), doc, 'FEA_ANALYSIS_NOT_FOUND');
    expectRefused(run(doc, 'delete_analysis_item', { analysisId, itemId: 'p' }), doc, 'FEA_ITEM_NOT_FOUND');
    expect(run(doc, 'add_result_probe', { analysisId, name: 'p', point: [0, 0], quantity: 'u_mag' }).summary).toContain('invalid params');
    expect(run(doc, 'add_result_probe', { analysisId, name: 'p', point: [0, 0, 0], quantity: 'speed' }).summary).toContain(
      'invalid params',
    );
    // the schema forbids NaN, so exercise the run-level check directly
    expectRefused(addResultProbe.run(doc, { analysisId, name: 'p', point: [0, 0, Infinity], quantity: 'u_mag' }), doc, 'FEA_PROBE_INVALID');
  });
});
