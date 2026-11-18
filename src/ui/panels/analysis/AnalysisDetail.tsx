// The open case of the Analysis panel: set-up, readiness checks and, once solved, the results.

import React from 'react';
import type { CadDocument } from '@core/model/types';
import { PanelSection, StatusLine } from '@ui/panels/PanelParts';
import type { CheckView, DescribeView } from './analysisData';
import type { SetupItems } from './analysisItems';
import { AnalysisActions } from './AnalysisActions';
import { AnalysisChecks } from './AnalysisChecks';
import { AnalysisKpis } from './AnalysisKpis';
import { AnalysisOnModel } from './AnalysisOnModel';
import { AnalysisResults } from './AnalysisResults';
import { AnalysisSetup } from './AnalysisSetup';
import { AnalysisSolvedSections } from './AnalysisSolvedSections';
import { AnalysisStateBadge } from './AnalysisStateBadge';
import { TopologyPanel } from './TopologyPanel';
import { VerificationPanel } from './VerificationPanel';

interface AnalysisDetailProps {
  described: DescribeView;
  check: CheckView | null;
  checkSummary: string;
  items: SetupItems | null;
  document: CadDocument;
  mode: number;
  onSelectMode: (mode: number) => void;
}

export function AnalysisDetail({
  described,
  check,
  checkSummary,
  items,
  document,
  mode,
  onSelectMode,
}: AnalysisDetailProps): React.ReactElement {
  const { analysisCase, state } = described;
  const solved = state === 'solved';
  return (
    <>
      {items !== null && <AnalysisKpis analysisCase={analysisCase} state={state} check={check} items={items} />}
      <AnalysisOnModel thermal={analysisCase.thermal !== undefined} solved={solved} />
      <PanelSection title="Case" hint="Case set-up as recorded in the document.">
        <p className="analysis__line" data-testid="analysis-meta">
          {analysisCase.type} · {analysisCase.solver} · {analysisCase.unitSystem} ·{' '}
          <AnalysisStateBadge state={state} withMeaning testId="analysis-state-badge" />
        </p>
        {described.problem !== null && <StatusLine text={described.problem} />}
      </PanelSection>
      <AnalysisSetup analysisCase={analysisCase} document={document} />
      <AnalysisChecks check={check} summary={checkSummary} partIds={Object.keys(analysisCase.parts)} />
      {solved && (
        <AnalysisSolvedSections analysisCase={analysisCase} document={document} items={items} mode={mode} onSelectMode={onSelectMode} />
      )}
      <AnalysisResults key={`results-${analysisCase.id}`} analysisCase={analysisCase} />
      {(solved || (analysisCase.studyOrder ?? []).length > 0) && (
        <VerificationPanel key={`verification-${analysisCase.id}`} analysisCase={analysisCase} />
      )}
      {analysisCase.type === 'static' && <TopologyPanel key={`topology-${analysisCase.id}`} analysisId={analysisCase.id} />}
      <AnalysisActions key={`actions-${analysisCase.id}`} analysisCase={analysisCase} />
    </>
  );
}
