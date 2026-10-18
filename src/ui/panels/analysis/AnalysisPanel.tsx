// Analysis (FEA / thermal) browser: the cases an agent set up, their reviewable set-up, readiness checks and result plots.
// Read-only: everything shown comes from describe_analysis / check_analysis / render_fea_results.

import React, { useMemo, useState } from 'react';
import '@ui/styles/panels/analysis.css';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import { execute } from '@core/commands/registry';
import { ListRow, PanelEmpty, PanelHeader, PanelSection, StatusLine } from '@ui/panels/PanelParts';
import { eigenOf, parseAnalysisList, parseCheck, parseDescribe } from './analysisData';
import { AnalysisChecks } from './AnalysisChecks';
import { AnalysisModes } from './AnalysisModes';
import { AnalysisProbes } from './AnalysisProbes';
import { AnalysisResults } from './AnalysisResults';
import { AnalysisSetup } from './AnalysisSetup';
import { useHostQuery } from './useHostQuery';

const ALL_CASES: Record<string, unknown> = {};

export function AnalysisPanel({ className }: { className?: string }): React.ReactElement {
  const document = useStore((s) => s.document);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const analysis = document.analysis;

  const local = useMemo(() => parseAnalysisList(execute(document, 'describe_analysis', {}).data), [document]);
  const listed = useHostQuery('describe_analysis', ALL_CASES, document);
  // The local list shows at once; the host's answer (states verified against its artifacts) replaces it when it arrives.
  const list = listed.status === 'done' && !listed.isError ? parseAnalysisList(listed.data) : local;
  const selectedId = list.find((item) => item.id === pickedId)?.id ?? list[0]?.id ?? null;
  const caseParams = useMemo(() => (selectedId === null ? null : { analysisId: selectedId }), [selectedId]);
  // Server-side when online: the mesh / results artifacts the state and the checks are verified against live there.
  const described = useHostQuery('describe_analysis', caseParams, document);
  const checked = useHostQuery('check_analysis', caseParams, document);
  const detail =
    selectedId === null || described.status === 'loading' || checked.status === 'loading'
      ? null
      : {
          described: parseDescribe(described.data),
          describeSummary: described.summary,
          check: parseCheck(checked.data),
          checkSummary: checked.summary,
        };

  const eigen = detail?.described == null ? null : eigenOf(detail.described.analysisCase);

  return (
    <aside className={classNames('panel', className)} aria-label="Analysis" data-testid="analysis-panel">
      <PanelHeader title="Analysis" count={list.length} countLabel={`${list.length} analyses`} />
      <PanelSection title="Cases" hint="Finite-element and thermal analyses set up in this document.">
        {list.length === 0 ? (
          <PanelEmpty compact icon="wireframe" message="No analyses yet" hint="Ask an agent to create_analysis, or run it from the CLI." />
        ) : (
          <ul className="panel__list" aria-label="Analyses">
            {list.map((item) => (
              <ListRow
                key={item.id}
                testId={`analysis-row-${item.id}`}
                buttonTestId={`analysis-open-${item.id}`}
                selected={item.id === selectedId}
                current={item.id === selectedId}
                label={`Open analysis ${item.name}`}
                onSelect={() => setPickedId(item.id)}
              >
                <span className="panel__row-main">{item.name}</span>
                <span className="panel__row-meta">
                  {item.type} · {item.state}
                </span>
              </ListRow>
            ))}
          </ul>
        )}
      </PanelSection>
      {detail !== null && selectedId !== null && detail.described === null && <StatusLine text={detail.describeSummary} />}
      {detail?.described != null && analysis !== undefined && (
        <>
          <PanelSection title="Case" hint="Case set-up as recorded in the document.">
            <p className="analysis__line" data-testid="analysis-meta">
              {detail.described.analysisCase.type} · {detail.described.analysisCase.solver} · {detail.described.analysisCase.unitSystem} ·{' '}
              {detail.described.state}
            </p>
            {detail.described.problem !== null && <StatusLine text={detail.described.problem} />}
          </PanelSection>
          <AnalysisSetup analysisCase={detail.described.analysisCase} document={document} />
          <AnalysisChecks check={detail.check} summary={detail.checkSummary} />
          {eigen !== null && detail.described.state === 'solved' && <AnalysisModes eigen={eigen} />}
          {detail.described.state === 'solved' && Object.keys(detail.described.analysisCase.probes ?? {}).length > 0 && (
            <AnalysisProbes analysisId={detail.described.analysisCase.id} refreshKey={document} />
          )}
          <AnalysisResults key={detail.described.analysisCase.id} analysisCase={detail.described.analysisCase} />
        </>
      )}
    </aside>
  );
}
