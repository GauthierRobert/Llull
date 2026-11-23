// Flow browser (12 CFD): the flow cases, their recorded result and grid study with their state (current, stale, unverified, not converged),
// the solve / stop controls, and what is drawn on the model (FlowOverlay). Document changes go through `dispatch` (create / delete case);
// the solve and the result queries are host transports (`cfd_solve`, `cfd_stop`, `cfd_slice`, `cfd_streamlines`), read-only here.

import React, { useEffect, useMemo, useRef } from 'react';
import '@ui/styles/panels/flow.css';
import { useStore } from '@ui/store';
import { useFlowViewStore } from '@ui/store/flowViewStore';
import { PanelEmpty, PanelHeader } from '@ui/panels/PanelParts';
import { useHostQuery } from '@ui/panels/analysis/useHostQuery';
import { classNames } from '@ui/classNames';
import { FlowCaseForm } from './FlowCaseForm';
import { FlowCaseList } from './FlowCaseList';
import { FlowLayersSection } from './FlowLayersSection';
import { FlowResultSection } from './FlowResultSection';
import { FlowSolveSection } from './FlowSolveSection';
import { FlowStudySection } from './FlowStudySection';
import { parseFlowReport, studyIsStale, type FlowCase, type FlowResult } from './flowData';

const NO_CASES: Readonly<Record<string, FlowCase>> = {};
const NO_RESULTS: Readonly<Record<string, FlowResult>> = {};

export function FlowPanel({ className }: { className?: string }): React.ReactElement {
  const cfd = useStore((s) => s.document.cfd);
  const cases = cfd?.cases ?? NO_CASES;
  const results = cfd?.results ?? NO_RESULTS;
  const caseIds = Object.keys(cases);
  const caseKey = caseIds.join('|');
  const picked = useFlowViewStore((s) => s.caseId);
  const setCase = useFlowViewStore((s) => s.setCase);
  const selectedId = picked !== null && Object.hasOwn(cases, picked) ? picked : (caseIds[0] ?? null);
  const selected = selectedId === null ? undefined : cases[selectedId];
  const result = selectedId === null ? undefined : results[selectedId];
  const study = selectedId === null ? undefined : cfd?.studies?.[selectedId];

  // The panel shows (and the overlay draws) the first case until one is picked or the picked one is deleted; a case created online
  // is not in the document yet when it is picked, so only a case that was there and went away resets the pick.
  const knownIds = useRef<readonly string[]>([]);
  useEffect(() => {
    const wasKnown = picked !== null && knownIds.current.includes(picked);
    knownIds.current = caseKey === '' ? [] : caseKey.split('|');
    if (selectedId !== picked && (picked === null || wasKnown)) setCase(selectedId);
  }, [caseKey, picked, selectedId, setCase]);
  useEffect(() => () => useFlowViewStore.getState().setCase(null), []);

  const reportQuery = useHostQuery('cfd_report', result === undefined || selectedId === null ? null : { caseId: selectedId }, cfd);
  const report = useMemo(
    () => (reportQuery.status === 'done' && !reportQuery.isError ? parseFlowReport(reportQuery.data) : null),
    [reportQuery],
  );
  const blocked =
    result === undefined
      ? 'Solve the case first: the slice and streamlines read its recorded flow field.'
      : report?.stale === true
        ? 'The result is stale: solve again to draw it.'
        : null;

  return (
    <aside className={classNames('panel', className)} aria-label="Flow" data-testid="flow-panel">
      <PanelHeader title="Flow" count={caseIds.length} countLabel={`${caseIds.length} flow cases`} />
      {selected === undefined ? (
        <PanelEmpty
          icon="aero"
          message="No flow case yet"
          hint="Select the solids, then create a case below: speed, reference area and length."
          compact
        />
      ) : (
        <FlowCaseList cases={cases} results={results} selectedId={selectedId} report={report} onSelect={setCase} />
      )}
      <FlowCaseForm suggestedId={`flow-${caseIds.length + 1}`} onCreated={setCase} />
      {selected !== undefined && selectedId !== null && (
        <>
          <FlowSolveSection key={selectedId} caseId={selectedId} />
          {result !== undefined && <FlowResultSection result={result} report={report} />}
          {study !== undefined && <FlowStudySection study={study} stale={studyIsStale(study, result, report)} />}
          <FlowLayersSection key={selectedId} cfdCase={selected} blocked={blocked} />
        </>
      )}
    </aside>
  );
}
