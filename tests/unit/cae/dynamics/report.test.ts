/** dynamic_report and equivalent_static_load_case on a solved random case (VC-DYN-41 named peak factor, VC-DYN-42 Miles refusal). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { mustRun, readyRandomStrip, SOURCE } from './fixtures';
import { solvedRandom } from './solvedFixtures';

const codeOf = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;

function solved(): ReturnType<typeof solvedRandom> & { analysisId: string; staticId: string } {
  const ready = readyRandomStrip();
  let doc = mustRun(ready.doc, 'add_result_probe', { analysisId: ready.analysisId, name: 'tip', point: [100, 10, 1.5], quantity: 'a_z' });
  doc = mustRun(doc, 'add_result_probe', { analysisId: ready.analysisId, name: 'tip_rel', point: [100, 10, 1.5], quantity: 'u_z_rel' });
  const result = solvedRandom(doc, ready.analysisId, ready.boxId);
  const statik = mustRun(result.doc, 'create_analysis', { name: 'quasi-static', analysisType: 'static' });
  return { ...result, doc: statik, analysisId: ready.analysisId, staticId: statik.analysis?.caseOrder.at(-1) ?? '' };
}

describe('dynamic_report', () => {
  it('returns the verified summary, filters probes and refuses stale / missing / non-dynamic cases', () => {
    const s = solved();
    const result = execute(s.doc, 'analysis_report', { view: 'dynamic', analysisId: s.analysisId, probes: ['tip'] }, s.ctx);
    expect(result.data).toMatchObject({ state: 'solved', summary: { type: 'random_response', probes: [{ probe: 'tip', unit: 'g' }] } });
    expect(result.summary).toContain('computed by llull, not approved');
    expect(result.summary).toContain('UNVERIFIED');
    expect(codeOf(execute(s.doc, 'analysis_report', { view: 'dynamic', analysisId: s.analysisId }))).toBe('DYN_RESULTS_MISSING');
    const stale = mustRun(s.doc, 'set_frequency_sweep', { analysisId: s.analysisId, fMinHz: 20, fMaxHz: 1000 });
    expect(codeOf(execute(stale, 'analysis_report', { view: 'dynamic', analysisId: s.analysisId }, s.ctx))).toBe('DYN_RESULTS_STALE');
    expect(codeOf(execute(s.doc, 'analysis_report', { view: 'dynamic', analysisId: s.staticId }, s.ctx))).toBe('DYN_CASE_TYPE');
    expect(codeOf(execute(s.doc, 'analysis_report', { view: 'dynamic', analysisId: 'nope' }, s.ctx))).toBe('FEA_ANALYSIS_NOT_FOUND');
  });
});

describe('equivalent_static_load_case', () => {
  it('adds peakFactor x rms g as a gravity load with the named 3-sigma default and provenance (VC-DYN-41)', () => {
    const s = solved();
    const before = JSON.stringify(s.doc);
    const result = execute(
      s.doc,
      'equivalent_static_load_case',
      { analysisId: s.analysisId, probe: 'tip', targetAnalysisId: s.staticId, loadCase: 'RV' },
      s.ctx,
    );
    expect(JSON.stringify(s.doc)).toBe(before);
    const id = result.affected[0] ?? '';
    const load = result.document.analysis?.cases[s.staticId]?.loads[id];
    const tipRms = (s.doc.analysis?.cases[s.analysisId]?.results?.dynamics?.probes.find((p) => p.probe === 'tip') as { rms: number }).rms;
    expect(load).toMatchObject({ kind: 'gravity', loadCase: 'RV', category: 'limit' });
    expect(load?.vector?.[2]).toBeCloseTo(3 * tipRms * 9806.65, 6);
    expect(load?.vector?.slice(0, 2)).toEqual([0, 0]);
    expect(result.summary).toContain('DEFAULT 3-sigma');
    expect(result.document.analysis?.vibration?.equivalentLoads?.[id]).toMatchObject({
      sourceAnalysisId: s.analysisId,
      from: { probe: 'tip' },
      spectrum: 'gevs_q',
      damping: 'modal',
      peakFactor: { value: 3, source: 'llull named default', defaulted: true, rationale: 'Gaussian 3-sigma (P(|x| > 3 sigma) = 0.27 %)' },
    });
    const nodal = execute(
      s.doc,
      'equivalent_static_load_case',
      {
        analysisId: s.analysisId,
        nodalMax: true,
        peakFactor: 4,
        peakFactorSource: 'company rule R-12',
        targetAnalysisId: s.staticId,
        loadCase: 'RV',
        category: 'ultimate',
      },
      s.ctx,
    );
    expect(nodal.summary).toContain('company rule R-12');
    expect(nodal.document.analysis?.vibration?.equivalentLoads?.[nodal.affected[0] ?? '']).toMatchObject({
      from: { nodalMax: 'a_z' },
      peakFactor: { value: 4, defaulted: false },
    });
  });

  it('refuses Miles (VC-DYN-42 DYN_MILES_NOT_ANSWER), non-static targets, bad probes and stale sources', () => {
    const s = solved();
    const base = { analysisId: s.analysisId, probe: 'tip', targetAnalysisId: s.staticId, loadCase: 'RV' };
    expect(codeOf(execute(s.doc, 'equivalent_static_load_case', { ...base, basis: 'miles' }, s.ctx))).toBe('DYN_MILES_NOT_ANSWER');
    expect(codeOf(execute(s.doc, 'equivalent_static_load_case', { ...base, targetAnalysisId: s.analysisId }, s.ctx))).toBe(
      'DYN_TARGET_NOT_STATIC',
    );
    expect(codeOf(execute(s.doc, 'equivalent_static_load_case', { ...base, targetAnalysisId: 'nope' }, s.ctx))).toBe(
      'FEA_ANALYSIS_NOT_FOUND',
    );
    expect(codeOf(execute(s.doc, 'equivalent_static_load_case', { ...base, probe: 'tip_rel' }, s.ctx))).toBe('DYN_PROBE_NOT_FOUND');
    expect(codeOf(execute(s.doc, 'equivalent_static_load_case', { ...base, nodalMax: true }, s.ctx))).toBe('DYN_PROBE_NOT_FOUND');
    expect(codeOf(execute(s.doc, 'equivalent_static_load_case', { ...base, loadCase: 'bad name!' }, s.ctx))).toBe('FEA_LOAD_INVALID');
    expect(codeOf(execute(s.doc, 'equivalent_static_load_case', { ...base, peakFactor: 0.5 }, s.ctx))).toBe('FEA_PARAM_INVALID');
    expect(codeOf(execute(s.doc, 'equivalent_static_load_case', base))).toBe('DYN_RESULTS_MISSING');
    const stale = mustRun(s.doc, 'set_dynamic_damping', {
      analysisId: s.analysisId,
      model: 'modal',
      ratios: [{ fromMode: 1, toMode: 6, zeta: 0.03 }],
      source: SOURCE,
    });
    expect(codeOf(execute(stale, 'equivalent_static_load_case', base, s.ctx))).toBe('DYN_RESULTS_STALE');
  });
});
