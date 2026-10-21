import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { analysisErrors } from '@cae/model/validate';
import { caseOf, withCase } from '@cae/shared/access';
import { mustRun } from '../deckFixtures';
import { nonlinearBar, pulledBar } from './support';

interface CheckData {
  readonly status: string;
  readonly items: readonly { readonly code: string; readonly severity: string; readonly remediation: string }[];
}

const checkCodes = (doc: Parameters<typeof execute>[0], analysisId: string): string[] =>
  (execute(doc, 'check_analysis', { analysisId }).data as CheckData).items.map((entry) => entry.code);

describe('check_analysis on a nonlinear_static case', () => {
  it('reports the missing controls and steps with their remediation', () => {
    const bar = nonlinearBar();
    const data = execute(bar.doc, 'check_analysis', { analysisId: bar.analysisId }).data as CheckData;
    const codes = data.items.map((entry) => entry.code);
    expect(codes).toContain('NLS_NLGEOM_UNSET');
    expect(data.items.find((entry) => entry.code === 'NLS_NLGEOM_UNSET')?.remediation).toContain('set_nonlinear_controls');
    const controlled = mustRun(bar.doc, 'set_nonlinear_controls', { analysisId: bar.analysisId, nlgeom: false });
    expect(checkCodes(controlled, bar.analysisId)).toContain('NLS_NO_STEPS');
    expect(checkCodes(controlled, bar.analysisId)).not.toContain('NLS_NLGEOM_UNSET');
  });

  it('is clean for a complete set-up and flags a probe whose constraint was deleted', () => {
    const bar = pulledBar();
    expect(checkCodes(bar.doc, bar.analysisId).filter((code) => code.startsWith('NLS_'))).toEqual([]);
    const gone = mustRun(bar.doc, 'delete_analysis_item', { analysisId: bar.analysisId, itemId: bar.constraints['x0'] });
    expect(checkCodes(gone, bar.analysisId)).toContain('NLS_PROBE_REFERENCE_UNKNOWN');
  });

  it('flags a part whose selected constitutive set does not exist any more', () => {
    const bar = pulledBar();
    const analysis = caseOf(bar.doc, bar.analysisId);
    expect(analysis?.nonlinear).toBeDefined();
    if (analysis?.nonlinear === undefined) return;
    const broken = withCase(bar.doc, { ...analysis, nonlinear: { ...analysis.nonlinear, constitutiveSets: { [bar.boxId]: 'ghost' } } });
    expect(checkCodes(broken, bar.analysisId)).toContain('NLS_MATERIAL_MODEL_MISSING');
  });

  it('keeps linear cases free of nonlinear items', () => {
    const bar = nonlinearBar();
    const linear = execute(bar.doc, 'create_analysis', { name: 'lin', analysisType: 'static' });
    expect(checkCodes(linear.document, linear.affected[0] ?? '').filter((code) => code.startsWith('NLS_'))).toEqual([]);
  });
});

describe('persistence validation of the nonlinear slice', () => {
  const raw = (doc: ReturnType<typeof pulledBar>['doc']): Record<string, unknown> =>
    JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;

  it('accepts a saved nonlinear case', () => {
    expect(analysisErrors(raw(pulledBar().doc))).toEqual([]);
    expect(analysisErrors(raw(nonlinearBar().doc))).toEqual([]);
  });

  it('rejects malformed settings and nonlinear settings on a linear case', () => {
    const bar = pulledBar();
    const mutate = (change: (nonlinear: Record<string, unknown>) => void): string[] => {
      const document = raw(bar.doc);
      const cases = (document['analysis'] as { cases: Record<string, { nonlinear: Record<string, unknown> }> }).cases;
      change(cases[bar.analysisId]!.nonlinear);
      return analysisErrors(document);
    };
    expect(mutate((nonlinear) => (nonlinear['nlgeom'] = 'yes')).join()).toContain('nlgeom must be true or false');
    expect(mutate((nonlinear) => (nonlinear['steps'] = {})).join()).toContain('missing');
    expect(mutate((nonlinear) => (nonlinear['constitutiveSets'] = { ghost: 'nl' })).join()).toContain("constitutiveSets: 'ghost'");
    expect(mutate((nonlinear) => (nonlinear['constitutiveSets'] = 3)).join()).toContain('constitutiveSets must be a record');
    expect(mutate((nonlinear) => (nonlinear['probes'] = { [bar.probeId]: { id: bar.probeId } })).join()).toContain('is malformed');
    const document = raw(bar.doc);
    const cases = (document['analysis'] as { cases: Record<string, Record<string, unknown>> }).cases;
    cases[bar.analysisId]!['type'] = 'static';
    expect(analysisErrors(document).join()).toContain('only nonlinear_static cases carry nonlinear settings');
  });
});
