/** compute_margins (05 §5.8): formulas, factors, statuses, refusals, trust, purity. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { withCase } from '@cae/shared/access';
import { mustRun, portOf } from './deckFixtures';
import { marginBar, type MarginBar } from './marginsFixtures';

interface Row {
  rowId: string;
  part: string;
  region: string;
  loadCase: string;
  category: string;
  check: string;
  criterion: string;
  appliedMPa: number;
  allowableMPa: number;
  allowable: { property: string; basis: string; provenance: string };
  factorApplied: number;
  ms: number | null;
  status: string;
  code?: string;
  atMm: number[];
  singular: boolean;
  unverified: boolean;
  unverifiedReasons: string[];
  reviewRequired: boolean;
  disposition: string;
}
interface Margins {
  minMs: number | null;
  factors: {
    ultimate: { value: number; source: string; defaulted: boolean };
    yield: { value: number; defaulted: boolean };
    extra: unknown[];
  };
  rows: Row[];
  warnings: string[];
  reviewRequired: boolean;
}

const margins = (bar: MarginBar, params: Record<string, unknown> = {}, doc = bar.recorded): ReturnType<typeof execute> =>
  execute(doc, 'compute_margins', { analysisId: bar.analysisId, ...params }, bar.ctx);

const dataOf = (result: ReturnType<typeof execute>): Margins => result.data as Margins;

describe('compute_margins', () => {
  it('computes ultimate and yield margins of a limit load case from the artifact, with named factors and review flags', () => {
    const bar = marginBar();
    const result = margins(bar);
    expect(result.rejected).not.toBe(true);
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(bar.recorded);
    const data = dataOf(result);
    const applied = data.rows[0]?.appliedMPa ?? 0;
    expect(applied).toBeCloseTo(210, 3);
    expect(data.rows.map((row) => [row.check, row.category, row.loadCase, row.part])).toEqual([
      ['ultimate', 'limit', 'LC1', bar.boxId],
      ['yield', 'limit', 'LC1', bar.boxId],
    ]);
    const [ultimate, yielded] = data.rows;
    expect(ultimate?.ms).toBeCloseTo(300 / (applied * 1.5) - 1, 12);
    expect(ultimate?.status).toBe('FAIL');
    expect(ultimate?.code).toBe('FEA_MS_NEGATIVE');
    expect(ultimate?.disposition).toBe('pending_human');
    expect(ultimate?.allowableMPa).toBe(300);
    expect(ultimate?.allowable).toMatchObject({ property: 'Ftu', basis: 'company' });
    expect(ultimate?.allowable.provenance).toContain('steel');
    expect(yielded?.ms).toBeCloseTo(250 / applied - 1, 12);
    expect(yielded?.status).toBe('PASS');
    expect(yielded?.disposition).toBe('none');
    expect(yielded?.code).toBeUndefined();
    expect(data.minMs).toBe(ultimate?.ms);
    expect(data.factors.ultimate).toMatchObject({ value: 1.5, source: '14 CFR 25.303', defaulted: true });
    expect(data.factors.yield).toMatchObject({ value: 1, defaulted: true });
    for (const row of data.rows) {
      expect(row.reviewRequired).toBe(true);
      expect(row.singular).toBe(false);
      expect(row.region).toBe('part');
      expect(row.atMm).toHaveLength(3);
    }
    expect(data.reviewRequired).toBe(true);
    expect(data.warnings.join(' ')).toContain('FEA_MARGINAL_BAND_UNSET');
    expect(result.summary).toContain('1 pending a human disposition');
    expect(result.summary).toContain('not approved');
  });

  it('applies stated and extra factors, and marks MARGINAL only when a band is given', () => {
    const factors = { ultimate: 1.2, yield: 1.1, extra: [{ name: 'fitting factor', value: 1.15, justification: 'company rule' }] };
    const bar = marginBar({ factors, ftu: 700, fty: 300 });
    const data = dataOf(margins(bar, { marginalBand: 0.5 }));
    const applied = data.rows[0]?.appliedMPa ?? 0;
    expect(data.factors.ultimate).toMatchObject({ value: 1.2, defaulted: false });
    expect(data.factors.extra).toHaveLength(1);
    expect(data.rows[0]?.factorApplied).toBeCloseTo(1.2 * 1.15, 12);
    expect(data.rows[1]?.factorApplied).toBeCloseTo(1.1 * 1.15, 12);
    expect(data.rows[0]?.ms).toBeCloseTo(700 / (applied * 1.2 * 1.15) - 1, 12);
    expect(data.rows[1]?.ms).toBeCloseTo(300 / (applied * 1.1 * 1.15) - 1, 12);
    expect(data.rows.map((row) => row.status)).toEqual(['PASS', 'MARGINAL']);
    expect(data.rows[1]?.code).toBe('FEA_MS_MARGINAL');
    expect(data.rows[1]?.disposition).toBe('pending_human');
    expect(data.warnings).toEqual([]);
    expect(dataOf(margins(bar)).rows.map((row) => row.status)).toEqual(['PASS', 'PASS']);
  });

  it('puts no ultimate factor on an ultimate load case and gives it no yield check', () => {
    const bar = marginBar({ category: 'ultimate' });
    const data = dataOf(margins(bar));
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({ check: 'ultimate', category: 'ultimate', factorApplied: 1, status: 'PASS' });
    expect(data.rows[0]?.ms).toBeCloseTo(300 / (data.rows[0]?.appliedMPa ?? 1) - 1, 12);
    const yieldOnly = margins(bar, { allowable: 'fty' });
    expect(yieldOnly.error?.code).toBe('FEA_MARGIN_PARAM_INVALID');
    expect(yieldOnly.document).toBe(bar.recorded);
  });

  it('runs one check with ftu / fty and converts an explicit allowable (always unverified)', () => {
    const bar = marginBar();
    expect(dataOf(margins(bar, { allowable: 'ftu' })).rows.map((row) => row.check)).toEqual(['ultimate']);
    expect(dataOf(margins(bar, { allowable: 'fty' })).rows.map((row) => row.check)).toEqual(['yield']);
    const explicit = dataOf(margins(bar, { allowable: { value: 40, unit: 'ksi', against: 'yield' } }));
    expect(explicit.rows).toHaveLength(1);
    expect(explicit.rows[0]?.check).toBe('yield');
    expect(explicit.rows[0]?.allowableMPa).toBeCloseTo(275.790291, 5);
    expect(explicit.rows[0]?.allowable.property).toBe('explicit');
    expect(explicit.rows[0]?.unverified).toBe(true);
    expect(explicit.rows[0]?.unverifiedReasons.join(' ')).toContain('without a material record');
    const defaultAgainst = dataOf(margins(bar, { allowable: { value: 500, unit: 'MPa' } }));
    expect(defaultAgainst.rows.map((row) => row.check)).toEqual(['ultimate']);
    expect(margins(bar, { allowable: { value: -1, unit: 'MPa' } }).error?.code).toBe('FEA_MATERIAL_NO_ALLOWABLE');
    expect(margins(bar, { allowable: { value: 5, unit: 'mm' } }).error?.code).toBe('FEA_MATERIAL_NO_ALLOWABLE');
  });

  it('propagates unverified flags of the allowable (typical basis, VC-MAT-23 / VC-FEA-64) and reads a component criterion', () => {
    const bar = marginBar({ ftuExtra: { basis: 'typical' } });
    const [ultimate, yielded] = dataOf(margins(bar)).rows;
    expect(ultimate?.unverified).toBe(true);
    expect(ultimate?.unverifiedReasons.some((reason) => reason.startsWith('Ftu:'))).toBe(true);
    expect(yielded?.unverifiedReasons.some((reason) => reason.startsWith('Ftu:'))).toBe(false);
    const stress = bar.results.steps[0]?.fields['STRESS']?.values ?? {};
    const sxx = Math.max(...Object.values(stress).map((values) => Math.abs(values[0] ?? 0)));
    const component = dataOf(margins(bar, { criterion: 's_xx', allowable: 'fty' })).rows[0];
    expect(component?.criterion).toBe('s_xx');
    expect(component?.appliedMPa).toBeCloseTo(sxx, 9);
  });

  it('groups by constraint / load target and filters load cases', () => {
    const bar = marginBar();
    const rows = dataOf(margins(bar, { groupBy: 'target', allowable: 'ftu' })).rows;
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.region.startsWith('C_')).toBe(true);
      expect(row.part).toBe(bar.boxId);
    }
    expect(dataOf(margins(bar, { loadCases: ['LC1'] })).rows).toHaveLength(2);
    expect(margins(bar, { loadCases: ['nope'] }).error?.code).toBe('FEA_MARGIN_PARAM_INVALID');
    expect(margins(bar, { marginalBand: -0.1 }).error?.code).toBe('FEA_MARGIN_PARAM_INVALID');
  });

  it('reads thermo_static results at the reference temperature under the case load case', () => {
    const bar = marginBar({ analysisType: 'thermo_static' });
    const result = margins(bar, { allowable: 'ftu' });
    expect(result.rejected).not.toBe(true);
    expect(dataOf(result).rows[0]).toMatchObject({ loadCase: 'thermal', category: 'limit', check: 'ultimate' });
  });

  it('refuses without a strength allowable, outside its validity, for the wrong type and for unknown analyses', () => {
    const noFty = marginBar({ fty: null });
    const missing = margins(noFty);
    expect(missing.error?.code).toBe('FEA_MATERIAL_NO_ALLOWABLE');
    expect(missing.summary).toContain('Fty');
    expect(missing.document).toBe(noFty.recorded);
    expect(dataOf(margins(noFty, { allowable: 'ftu' })).rows).toHaveLength(1);
    expect(margins(noFty, { allowable: { value: 250, unit: 'MPa', against: 'yield' } }).rejected).not.toBe(true);
    const outside = marginBar({ ftuExtra: { validity: [{ variable: 'T', unit: 'K', data: [400, 500] }] } });
    const range = margins(outside, { allowable: 'ftu' });
    expect(range.error?.code).toBe('FEA_MATERIAL_NO_ALLOWABLE');
    expect(range.summary).toContain('PROP_OUT_OF_RANGE');
    const heat = execute(noFty.recorded, 'create_analysis', { name: 'H', analysisType: 'heat_steady' });
    const heatMargins = execute(heat.document, 'compute_margins', { analysisId: heat.affected[0] ?? '' });
    expect(heatMargins.error?.code).toBe('FEA_ANALYSIS_TYPE_UNSUPPORTED');
    expect(execute(createEmptyDocument(), 'compute_margins', { analysisId: 'an-9' }).error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
  });

  it('refuses stale, missing and tampered results; never mutates', () => {
    const bar = marginBar();
    const before = JSON.stringify(bar.recorded);
    margins(bar);
    expect(JSON.stringify(bar.recorded)).toBe(before);
    const edited = mustRun(bar.recorded, 'set_mesh_controls', { analysisId: bar.analysisId, globalSize: 3 });
    expect(margins(bar, {}, edited).error?.code).toBe('FEA_RESULTS_STALE');
    const meshedOnly = execute(bar.doc, 'compute_margins', { analysisId: bar.analysisId }, bar.ctx);
    expect(meshedOnly.error?.code).toBe('FEA_RESULTS_MISSING');
    const emptyStore = execute(bar.recorded, 'compute_margins', { analysisId: bar.analysisId }, { ...bar.ctx, feaArtifacts: portOf() });
    expect(emptyStore.error?.code).toBe('FEA_RESULTS_MISSING');
    expect(execute(bar.recorded, 'compute_margins', { analysisId: bar.analysisId }).error?.code).toBe('FEA_RESULTS_MISSING');
    const analysis = bar.recorded.analysis?.cases[bar.analysisId];
    const results = analysis?.results;
    if (analysis === undefined || results === undefined) throw new Error('fixture lost its results');
    const tampered = withCase(bar.recorded, {
      ...analysis,
      results: { ...results, loadCases: results.loadCases.map((lc) => ({ ...lc, maxVonMises: { ...lc.maxVonMises, value: 1 } })) },
    });
    expect(margins(bar, {}, tampered).error?.code).toBe('FEA_SUMMARY_MISMATCH');
  });
});
