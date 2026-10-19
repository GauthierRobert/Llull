// Solve button of one study: runs the topology_solve host tool; disabled with its reason while the backend is offline or lacks the tool.

import React from 'react';
import { PanelSection, StatusLine } from '@ui/panels/PanelParts';
import { useTopologySolve } from './useTopologySolve';

export function TopologySolve({ studyId }: { studyId: string }): React.ReactElement {
  const { state, disabledReason, start } = useTopologySolve(studyId);
  return (
    <PanelSection title="Solve" hint="Runs the optimiser on this machine; the result is recorded in the document when it finishes.">
      <button
        type="button"
        className="btn btn--primary btn--sm"
        data-testid="topology-solve"
        disabled={disabledReason !== null}
        aria-describedby={disabledReason === null ? undefined : `topology-solve-reason-${studyId}`}
        onClick={start}
      >
        {state.status === 'running' ? 'Solving…' : 'Solve'}
      </button>
      {disabledReason !== null && state.status !== 'running' && (
        <p className="analysis__hint" id={`topology-solve-reason-${studyId}`} data-testid="topology-solve-reason">
          {disabledReason}
        </p>
      )}
      {state.status === 'running' && (
        <div data-testid="topology-progress">
          <progress className="topology__progress" aria-label="Topology solve in progress" />
          <p className="analysis__hint">Optimising, {state.elapsedS} s elapsed. The panel updates when the result is recorded.</p>
        </div>
      )}
      {state.status === 'done' && <StatusLine text={state.summary} testId="topology-solve-summary" />}
      {state.status === 'failed' && (
        <>
          <StatusLine text={state.summary} testId="topology-solve-summary" />
          {state.remediation !== '' && <p className="analysis__hint">{`${state.code ?? ''} ${state.remediation}`.trim()}</p>}
        </>
      )}
    </PanelSection>
  );
}
