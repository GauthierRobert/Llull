import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { solvedWall } from './solved';

function withRecordedBalance(doc: CadDocument, analysisId: string, balance: Record<string, number>): CadDocument {
  const model = doc.analysis;
  const analysisCase = model?.cases[analysisId];
  const results = analysisCase?.results;
  if (model === undefined || analysisCase === undefined || results?.thermal === undefined) throw new Error('fixture not solved');
  const next: AnalysisCase = {
    ...analysisCase,
    results: { ...results, thermal: { ...results.thermal, heatBalance: { ...results.thermal.heatBalance, ...balance } } },
  };
  return { ...doc, analysis: { ...model, cases: { ...model.cases, [analysisId]: next } } };
}

describe('heat balance and the trust check', () => {
  it('keeps results recorded by an older heat-balance summariser trusted, and shows the recomputed balance', () => {
    const wall = solvedWall();
    const ctx = { ...defaultContext(), feaArtifacts: wall.port };
    const older = withRecordedBalance(wall.solved, wall.analysisId, { residualRel: 0.5, inW: 1 });
    const result = execute(older, 'thermal_report', { analysisId: wall.analysisId }, ctx);
    const data = result.data as { state: string; heatBalance: { residualRel: number } };
    expect(data.state).toBe('solved');
    expect(data.heatBalance.residualRel).toBeLessThan(1e-6);
  });

  it('still flags a tampered temperature summary as untrusted', () => {
    const wall = solvedWall();
    const ctx = { ...defaultContext(), feaArtifacts: wall.port };
    const model = wall.solved.analysis;
    const analysisCase = model?.cases[wall.analysisId];
    const thermal = analysisCase?.results?.thermal;
    if (model === undefined || analysisCase?.results === undefined || thermal === undefined) throw new Error('fixture not solved');
    const tampered: CadDocument = {
      ...wall.solved,
      analysis: {
        ...model,
        cases: {
          ...model.cases,
          [wall.analysisId]: {
            ...analysisCase,
            results: { ...analysisCase.results, thermal: { ...thermal, maxT: { ...thermal.maxT, value: 1 } } },
          },
        },
      },
    };
    expect((execute(tampered, 'thermal_report', { analysisId: wall.analysisId }, ctx).data as { state: string }).state).toBe('untrusted');
  });
});
