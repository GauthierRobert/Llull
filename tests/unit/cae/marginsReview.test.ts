/** FEA-REST part 3 review: shell fibre stresses in margins, composite shells left out, shell edge supports not singular, singular findings in check_analysis. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { AnalysisCase } from '@core/model/analysis';
import { appliedOverFibres } from '@cae/margins/fibreStress';
import { compositeWarnings, exclusionWarnings, isCompositeEntity, orphanSingularKeys } from '@cae/margins/screenWarnings';
import { screenSingularities } from '@cae/margins/singularity';
import { vonMises } from '@cae/results/fields';
import { marginBar } from './marginsFixtures';

const items = (result: ReturnType<typeof execute>): { code: string; severity: string; ids: string[] }[] =>
  (result.data as { items: { code: string; severity: string; ids: string[] }[] }).items;

describe('shell fibre stresses in the applied stress', () => {
  it('takes the bending fibre, not the membrane average of a plate in pure bending', () => {
    const fields = {
      STRESS: { values: { '1': [0, 0, 0, 0, 0, 0], '2': [1, 0, 0, 0, 0, 0] } },
      STRESS_TOP: { values: { '1': [200, 0, 0, 0, 0, 0], '2': [1, 0, 0, 0, 0, 0] } },
      STRESS_BOT: { values: { '1': [-250, 0, 0, 0, 0, 0], '2': [1, 0, 0, 0, 0, 0] } },
    };
    expect(appliedOverFibres(fields, [1, 2], vonMises)).toEqual({ node: 1, value: 250, fibre: 'bottom' });
    expect(appliedOverFibres(fields, [2], vonMises)).toEqual({ node: 2, value: 1, fibre: 'mid' });
    expect(appliedOverFibres({ STRESS: fields.STRESS }, [2], vonMises)).toEqual({ node: 2, value: 1 });
    expect(appliedOverFibres(fields, [9], vonMises)).toBeNull();
    expect(appliedOverFibres({ STRESS: { values: { '1': [Number.NaN] } } }, [1], vonMises)).toBeNull();
  });
});

describe('what the margin table leaves out', () => {
  const bar = marginBar({ pointSupportsSingular: true });
  const analysis = bar.recorded.analysis?.cases[bar.analysisId] as AnalysisCase;
  const shellPart: AnalysisCase = {
    ...analysis,
    parts: { [bar.boxId]: { kind: 'shell', thickness: 1, offset: 'mid', midsurface: { maxThickness: 1, angularTolDeg: 1 } } },
  };

  it('does not treat a shell / plane-stress edge support as a singular source', () => {
    expect(screenSingularities(bar.recorded, analysis, bar.mesh, undefined).data['sources']).toHaveLength(2);
    expect(screenSingularities(bar.recorded, shellPart, bar.mesh, undefined).data['sources']).toEqual([]);
    const plane: AnalysisCase = { ...analysis, parts: { [bar.boxId]: { kind: 'plane_stress', thickness: 1, sourceFacesNear: [] } } };
    expect(screenSingularities(bar.recorded, plane, bar.mesh, undefined).data['sources']).toEqual([]);
  });

  it('names composite shells and large exclusions, and finds groups that are entirely singular', () => {
    const composite: AnalysisCase = {
      ...shellPart,
      parts: {
        [bar.boxId]: {
          kind: 'shell',
          thickness: 1,
          offset: 'mid',
          midsurface: { maxThickness: 1, angularTolDeg: 1 },
          laminate: { compositePartId: 'cp' },
        },
      },
    };
    expect(isCompositeEntity(composite, bar.boxId)).toBe(true);
    expect(isCompositeEntity(shellPart, bar.boxId)).toBe(false);
    expect(isCompositeEntity(shellPart, 'ghost')).toBe(false);
    expect(compositeWarnings(composite)[0]).toMatch(/^FEA_COMPOSITE_MARGINS_UNSUPPORTED: composite shell/);
    expect(compositeWarnings(analysis)).toEqual([]);
    expect(exclusionWarnings(bar.mesh, new Set())).toEqual([]);
    expect(exclusionWarnings(bar.mesh, new Set([1]))).toEqual([]);
    expect(exclusionWarnings(bar.mesh, new Set([1, 2, 3, 4, 5]))[0]).toContain('63 % of the nodes');
    expect(
      orphanSingularKeys([
        { rowKey: 'a', singular: false },
        { rowKey: 'a|singular', singular: true },
        { rowKey: 'b|singular', singular: true },
      ]),
    ).toEqual(['b']);
  });
});

describe('check_analysis singular findings', () => {
  it('warns about a failing singular row instead of dropping it', () => {
    const weak = marginBar({ pointSupportsSingular: true, ftu: 20, fty: 10 });
    const found = items(execute(weak.recorded, 'check_analysis', { analysisId: weak.analysisId }, weak.ctx));
    const singular = found.find((item) => item.code === 'FEA_MS_SINGULAR_FAIL');
    expect(singular?.severity).toBe('warning');
    expect(singular?.ids.length).toBeGreaterThan(1);
    expect(found.some((item) => item.code === 'FEA_MS_NEGATIVE')).toBe(true);
  });

  it('errors when the default radius swallows the whole part, and warns about the large exclusion', () => {
    const coarse = marginBar({ pointSupportsSingular: true, globalSize: 10 });
    const found = items(execute(coarse.recorded, 'check_analysis', { analysisId: coarse.analysisId }, coarse.ctx));
    expect(found.find((item) => item.code === 'FEA_MS_ALL_SINGULAR')?.severity).toBe('error');
    expect(found.find((item) => item.code === 'FEA_SINGULAR_EXCLUSION_LARGE')?.severity).toBe('warning');
  });
});
