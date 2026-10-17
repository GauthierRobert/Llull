// Analysis tab (05 FEA hand-off, PHY-03 thermal): the FE cases of the document as cards, and the focused case as a four-step workflow:
// set-up, check & solve (server: Gmsh + CalculiX), results, margins / temperature limits. The viewport draws the focused case's
// supports, loads and probes (FeaSetupOverlay) while this panel is open.

import React, { useEffect, useState } from 'react';
import type { AnalysisCase } from '@core/model/analysis';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import { useAnalysisViewStore } from '@ui/store/analysisViewStore';
import { PanelEmpty, PanelHeader } from '@ui/panels/PanelParts';
import { ANALYSIS_TYPE_LABELS, PROGRESS_LABELS, caseProgress, isThermalCase } from './analysisView';
import { CaseSetupSection } from './CaseSetupSection';
import { CaseCheckSection, CaseMarginsSection, CaseResultsSection } from './CaseRunSections';

function CaseCard({ analysis, active, onSelect }: { analysis: AnalysisCase; active: boolean; onSelect: () => void }): React.ReactElement {
  const progress = caseProgress(analysis);
  const loadCount = isThermalCase(analysis.type) ? (analysis.thermal?.bcOrder.length ?? 0) : analysis.loadOrder.length;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className={classNames('analysis-card', active && 'analysis-card--active')}
      onClick={onSelect}
      data-testid={`analysis-case-${analysis.id}`}
    >
      <span
        className={classNames('analysis-card__kind', isThermalCase(analysis.type) && 'analysis-card__kind--thermal')}
        aria-hidden="true"
      >
        {isThermalCase(analysis.type) ? 'T' : 'σ'}
      </span>
      <span className="analysis-card__body">
        <span className="analysis-card__name">{analysis.name}</span>
        <span className="analysis-card__meta">
          {ANALYSIS_TYPE_LABELS[analysis.type]} · {Object.keys(analysis.parts).length} part(s) · {loadCount}{' '}
          {isThermalCase(analysis.type) ? 'condition(s)' : 'load(s)'}
        </span>
      </span>
      <span className={`chip analysis-card__progress analysis-card__progress--${progress}`}>{PROGRESS_LABELS[progress]}</span>
    </button>
  );
}

export function AnalysisPanel({ className }: { className?: string }): React.ReactElement {
  const model = useStore((s) => s.document.analysis);
  const focusAnalysis = useAnalysisViewStore((s) => s.focusAnalysis);
  const [chosen, setChosen] = useState('');
  const order = model?.caseOrder ?? [];
  const caseId = order.includes(chosen) ? chosen : (order[0] ?? '');
  const analysis = model?.cases[caseId];

  useEffect(() => {
    focusAnalysis(caseId === '' ? null : caseId);
  }, [caseId, focusAnalysis]);
  useEffect(() => () => focusAnalysis(null), [focusAnalysis]);

  return (
    <aside className={classNames('panel analysis-panel', className)} aria-label="Analysis">
      <PanelHeader title="Analysis" count={order.length} countLabel={`${order.length} analysis cases`} />
      {analysis === undefined ? (
        <PanelEmpty
          icon="analysis"
          message="No analysis case yet."
          hint="create_analysis (static or thermal), then add parts, supports and loads; the agent can do it for you."
          compact
        />
      ) : (
        <>
          <div className="analysis-cards" role="radiogroup" aria-label="Analysis cases">
            {order.map((id) => {
              const item = model?.cases[id];
              return item === undefined ? null : (
                <CaseCard key={id} analysis={item} active={id === caseId} onSelect={() => setChosen(id)} />
              );
            })}
          </div>
          <CaseSetupSection analysis={analysis} />
          <CaseCheckSection key={`check-${caseId}`} analysis={analysis} />
          <CaseResultsSection key={`results-${caseId}`} analysis={analysis} />
          <CaseMarginsSection key={`margins-${caseId}`} analysis={analysis} />
        </>
      )}
    </aside>
  );
}
