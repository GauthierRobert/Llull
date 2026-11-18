// Result sections of a solved case in the Analysis panel (modes, summary, curves, margins, probes).

import React from 'react';
import type { CadDocument } from '@core/model/types';
import type { AnalysisCase } from '@core/model/analysis';
import { eigenOf } from './analysisData';
import type { SetupItems } from './analysisItems';
import { AnalysisMargins } from './AnalysisMargins';
import { AnalysisModes } from './AnalysisModes';
import { AnalysisProbes } from './AnalysisProbes';
import { AnalysisResultSummary } from './AnalysisResultSummary';
import { NonlinearCurves } from './NonlinearCurves';
import { recordResultView } from './useResultView';

interface AnalysisSolvedSectionsProps {
  analysisCase: AnalysisCase;
  document: CadDocument;
  items: SetupItems | null;
  mode: number;
  onSelectMode: (mode: number) => void;
}

export function AnalysisSolvedSections({
  analysisCase,
  document,
  items,
  mode,
  onSelectMode,
}: AnalysisSolvedSectionsProps): React.ReactElement {
  const eigen = eigenOf(analysisCase);
  return (
    <>
      {eigen !== null && (
        <AnalysisModes
          eigen={eigen}
          selectedMode={mode}
          onSelect={(next) => {
            onSelectMode(next);
            recordResultView(analysisCase);
          }}
        />
      )}
      <AnalysisResultSummary analysisCase={analysisCase} />
      {analysisCase.type === 'nonlinear_static' && <NonlinearCurves key={`nonlinear-${analysisCase.id}`} analysisCase={analysisCase} />}
      {(analysisCase.type === 'static' || analysisCase.type === 'thermo_static') && <AnalysisMargins analysisCase={analysisCase} />}
      {Object.keys(analysisCase.probes ?? {}).length > 0 && (
        <AnalysisProbes
          analysisId={analysisCase.id}
          refreshKey={document}
          items={Object.fromEntries((items?.probes ?? []).map((item) => [item.id, item]))}
        />
      )}
    </>
  );
}
