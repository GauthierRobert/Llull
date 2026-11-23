// Run controls of a case: `cfd_solve` (optionally the three-grid study) and `cfd_stop`, through the backend transport.

import React, { useState } from 'react';
import { OptionSelect } from '@ui/panels/OptionSelect';
import { PanelSection, StatusLine } from '@ui/panels/PanelParts';
import { useFlowSolve, type FlowSolveOptions } from './useFlowSolve';

const DEVICES: readonly FlowSolveOptions['device'][] = ['cpu', 'auto', 'gpu'];
const DEVICE_TEXT: Readonly<Record<FlowSolveOptions['device'], string>> = {
  cpu: 'CPU (reference, deterministic)',
  auto: 'Auto (GPU when available)',
  gpu: 'GPU',
};

export function FlowSolveSection({ caseId }: { caseId: string }): React.ReactElement {
  const { state, disabledReason, stopNote, start, stop } = useFlowSolve(caseId);
  const [gridStudy, setGridStudy] = useState(false);
  const [device, setDevice] = useState<FlowSolveOptions['device']>('cpu');
  const running = state.status === 'running';
  return (
    <PanelSection
      title="Solve"
      hint="Runs on this machine; the result is recorded in the document when the run ends. A stopped run records nothing."
      testId="flow-solve-section"
    >
      <label className="loads-check">
        <input
          type="checkbox"
          checked={gridStudy}
          disabled={running}
          onChange={(e) => setGridStudy(e.target.checked)}
          data-testid="flow-grid-study"
        />
        Grid study (three solves: n, n/2, n/4 cells per length)
      </label>
      <label className="field">
        <span className="field__label">Device</span>
        <OptionSelect
          value={device}
          options={DEVICES}
          label="Device"
          optionLabel={(d) => DEVICE_TEXT[d]}
          testId="flow-device"
          onChange={setDevice}
        />
      </label>
      <div className="flow__buttons">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          data-testid="flow-solve"
          disabled={disabledReason !== null}
          aria-describedby={disabledReason === null ? undefined : 'flow-solve-reason'}
          onClick={() => start({ gridStudy, device })}
        >
          {running ? 'Solving…' : gridStudy ? 'Solve with grid study' : 'Solve'}
        </button>
        <button type="button" className="btn btn--sm" data-testid="flow-stop" disabled={!running} onClick={stop}>
          Stop
        </button>
      </div>
      {disabledReason !== null && !running && (
        <p className="analysis__hint" id="flow-solve-reason" data-testid="flow-solve-reason">
          {disabledReason}
        </p>
      )}
      {state.status === 'running' && (
        <div data-testid="flow-progress">
          <progress className="flow__progress" aria-label="Flow solve in progress" />
          <p className="analysis__hint">
            {state.gridStudy ? 'Solving three grids' : 'Solving'}, {state.elapsedS} s elapsed. The panel updates when the result is
            recorded.
          </p>
        </div>
      )}
      {stopNote !== '' && <StatusLine text={stopNote} testId="flow-stop-note" />}
      {(state.status === 'done' || state.status === 'cancelled') && <StatusLine text={state.summary} testId="flow-solve-summary" />}
      {state.status === 'failed' && (
        <>
          <StatusLine text={state.summary} testId="flow-solve-summary" />
          {state.remediation !== '' && <p className="analysis__hint">{`${state.code ?? ''} ${state.remediation}`.trim()}</p>}
        </>
      )}
    </PanelSection>
  );
}
