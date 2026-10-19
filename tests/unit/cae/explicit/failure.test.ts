/** set_johnson_cook_failure and its job wiring (TR-EXP-21, RS-8b erosion; constants are synthetic validation-pack test inputs, Q7). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { buildExplicitJob } from '@cae/index';
import { explicitErrors } from '@cae/explicit/model';
import { barModel, code, must } from './support';

const D_TEST = [0.05, 3.44, -2.12, 0.002, 0.61];
const SOURCE = 'validation pack test input (generate_explicit_reference.py D_TEST), not a material claim';

describe('set_johnson_cook_failure', () => {
  const plastic = barModel({ plastic: true, size: 10 });

  it('stores the constants with their source, purely, keeps them across set_explicit_controls and passes them to the job', () => {
    const before = structuredClone(plastic.doc);
    const set = must(plastic.doc, 'set_johnson_cook_failure', {
      analysisId: plastic.analysisId,
      material: 'steel_like',
      D: D_TEST,
      source: SOURCE,
    });
    expect(plastic.doc).toEqual(before);
    expect(set.document.analysis?.cases[plastic.analysisId]?.explicit?.failure).toEqual({ steel_like: { D: D_TEST, source: SOURCE } });
    expect(set.summary).toContain('elements erode at damage 1');
    const controls = must(set.document, 'set_explicit_controls', {
      analysisId: plastic.analysisId,
      endTime: { value: 1e-4, unit: 's' },
      historyInterval: { value: 1e-6, unit: 's' },
      mesh: { kind: 'structured_hex', size: 10 },
    });
    expect(controls.document.analysis?.cases[plastic.analysisId]?.explicit?.failure).toBeDefined();
    const built = buildExplicitJob(controls.document, plastic.analysisId, null);
    if (!built.ok) throw new Error(built.message);
    expect(built.job.materialFailure).toEqual([D_TEST]);
    expect(explicitErrors(JSON.parse(JSON.stringify(controls.document)) as Record<string, unknown>)).toEqual([]);
    const cleared = must(set.document, 'set_johnson_cook_failure', { analysisId: plastic.analysisId, material: 'steel_like' });
    expect(cleared.document.analysis?.cases[plastic.analysisId]?.explicit?.failure).toBeUndefined();
  });

  it('refuses without a source, with non-finite values, for unused materials and without controls', () => {
    const params = { analysisId: plastic.analysisId, material: 'steel_like', D: D_TEST };
    expect(code(execute(plastic.doc, 'set_johnson_cook_failure', params))).toBe('EXP_PARAM_INVALID');
    expect(code(execute(plastic.doc, 'set_johnson_cook_failure', { ...params, source: SOURCE, D: [1, 2, 3, 4, Number.NaN] }))).toBe(
      'CMD_INVALID_PARAMS',
    );
    expect(code(execute(plastic.doc, 'set_johnson_cook_failure', { ...params, source: SOURCE, material: 'nope' }))).toBe(
      'EXP_TARGET_NOT_IN_CASE',
    );
    const fresh = must(plastic.doc, 'create_analysis', { name: 'b', analysisType: 'explicit_dynamics' });
    expect(code(execute(fresh.document, 'set_johnson_cook_failure', { ...params, source: SOURCE, analysisId: fresh.affected[0] }))).toBe(
      'EXP_CONTROLS_MISSING',
    );
    expect(code(execute(plastic.doc, 'set_johnson_cook_failure', { ...params, source: SOURCE, analysisId: 'an-404' }))).toBe(
      'FEA_ANALYSIS_NOT_FOUND',
    );
  });

  it('refuses a job whose failure material has no Johnson-Cook strength', () => {
    const elastic = barModel({ size: 10 });
    const set = must(elastic.doc, 'set_johnson_cook_failure', {
      analysisId: elastic.analysisId,
      material: 'steel_like',
      D: D_TEST,
      source: SOURCE,
    });
    const built = buildExplicitJob(set.document, elastic.analysisId, null);
    expect(built.ok ? 'ok' : built.code).toBe('EXP_MATERIAL_INCOMPLETE');
    const raw = JSON.parse(JSON.stringify(set.document)) as { analysis: { cases: Record<string, { explicit: Record<string, unknown> }> } };
    const spec = raw.analysis.cases[elastic.analysisId]?.explicit;
    if (spec === undefined) throw new Error('no spec');
    spec['failure'] = { steel_like: { D: [1, 2], source: 'x' } };
    expect(explicitErrors(raw as unknown as Record<string, unknown>)).toEqual([
      `analysis.cases.${elastic.analysisId}.explicit.failure is malformed`,
    ]);
  });
});
