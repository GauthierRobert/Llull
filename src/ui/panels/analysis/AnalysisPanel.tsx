// Analysis (FEA / thermal) browser: the cases an agent set up, their reviewable set-up, readiness checks and result plots.
// Read-only: everything shown comes from describe_analysis / check_analysis / render_fea_results.

import React, { useEffect, useMemo } from 'react';
import '@ui/styles/panels/analysis.css';
import { classNames } from '@ui/classNames';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { execute } from '@core/commands/registry';
import { PanelHeader, StatusLine } from '@ui/panels/PanelParts';
import { parseAnalysisList, parseCheck, parseDescribe } from './analysisData';
import { AnalysisCaseList } from './AnalysisCaseList';
import { AnalysisDetail } from './AnalysisDetail';
import { buildSetupItems } from './analysisItems';
import { useAnalysisViewStore } from './analysisViewStore';
import { useHostQuery } from './useHostQuery';

const ALL_CASES: Record<string, unknown> = {};

export function AnalysisPanel({ className }: { className?: string }): React.ReactElement {
  const document = useDocumentWithoutSelection();
  const pickedId = useAnalysisViewStore((s) => s.analysisId);
  const setActive = useAnalysisViewStore((s) => s.setActive);
  const mode = useAnalysisViewStore((s) => s.mode);
  const setMode = useAnalysisViewStore((s) => s.setMode);
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

  // The case drawn on the model follows the open case while this panel is open.
  useEffect(() => setActive(selectedId), [selectedId, setActive]);
  useEffect(() => () => setActive(null), [setActive]);
  const items = useMemo(
    () => (detail?.described == null ? null : buildSetupItems(document, detail.described.analysisCase)),
    [document, detail?.described],
  );

  return (
    <aside className={classNames('panel', className)} aria-label="Analysis" data-testid="analysis-panel">
      <PanelHeader title="Analysis" count={list.length} countLabel={`${list.length} analyses`} />
      <AnalysisCaseList list={list} selectedId={selectedId} onSelect={setActive} />
      {detail !== null && selectedId !== null && detail.described === null && <StatusLine text={detail.describeSummary} />}
      {detail?.described != null && analysis !== undefined && (
        <AnalysisDetail
          described={detail.described}
          check={detail.check}
          checkSummary={detail.checkSummary}
          items={items}
          document={document}
          mode={mode}
          onSelectMode={setMode}
        />
      )}
    </aside>
  );
}
