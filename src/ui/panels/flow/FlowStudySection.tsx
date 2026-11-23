// The grid-convergence study of a case: the three levels, observed order, GCI and the verified / unverified and stale states.

import React from 'react';
import { PanelSection, StatusChip } from '@ui/panels/PanelParts';
import { studyView, type FlowStudy } from './flowData';

export function FlowStudySection({ study, stale }: { study: FlowStudy; stale: boolean }): React.ReactElement {
  const view = studyView(study, stale);
  return (
    <PanelSection title={`Grid study (${view.quantityLabel})`} testId="flow-study">
      <p className="flow__state">
        <StatusChip tone={view.badge.tone} text={view.badge.text} testId="flow-study-badge" />
        {!study.verified && (
          <span className="analysis__hint">Replayed without the result bundles: no number is trusted until it is solved here.</span>
        )}
      </p>
      {view.staleNote !== '' && (
        <p className="flow__note flow__note--warn" role="status" data-testid="flow-study-stale">
          {view.staleNote}
        </p>
      )}
      <table className="flow__table" data-testid="flow-study-levels" aria-label="Grid levels, finest first">
        <thead>
          <tr>
            <th scope="col">Level</th>
            <th scope="col">Cell</th>
            <th scope="col">{view.quantityLabel}</th>
          </tr>
        </thead>
        <tbody>
          {view.levels.map((level, index) => (
            <tr key={level.key}>
              <th scope="row">{['Fine', 'Medium', 'Coarse'][index]}</th>
              <td title={level.cellsText}>{level.cellText}</td>
              <td>
                {level.valueText}
                {!level.converged && (
                  <span className="flow__flag" title="This level did not converge">
                    {' '}
                    not converged
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={`flow__note flow__note--${view.verdict.tone}`} data-testid="flow-study-verdict">
        {view.verdict.text}
      </p>
      {view.details.length > 0 && (
        <dl className="flow__details">
          {view.details.map((row) => (
            <React.Fragment key={row.key}>
              <dt>{row.label}</dt>
              <dd data-testid={`flow-study-${row.key}`}>{row.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {view.unconverged && (
        <p className="analysis__hint" data-testid="flow-study-unconverged">
          At least one level did not reach steady state; the GCI includes that error.
        </p>
      )}
    </PanelSection>
  );
}
