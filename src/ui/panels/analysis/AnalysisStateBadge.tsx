// State badge of an analysis case: colour by tone, a one-line meaning for the states that need attention.

import React from 'react';
import { classNames } from '@ui/classNames';
import { stateInfo } from './analysisState';

interface AnalysisStateBadgeProps {
  state: string;
  /** Show the one-line meaning next to the badge (warning states only). */
  withMeaning?: boolean;
  testId?: string;
}

export function AnalysisStateBadge({ state, withMeaning = false, testId }: AnalysisStateBadgeProps): React.ReactElement {
  const info = stateInfo(state);
  return (
    <span className="analysis__state">
      <span
        className={classNames(
          'analysis__state-badge',
          `analysis__state-badge--${info.tone}`,
          info.warning && 'analysis__state-badge--warning',
        )}
        data-state={state}
        data-testid={testId}
        title={info.meaning === '' ? undefined : info.meaning}
      >
        {info.label}
      </span>
      {withMeaning && info.meaning !== '' && info.warning && (
        <span className="analysis__state-meaning" data-testid="analysis-state-meaning">
          {info.meaning}
        </span>
      )}
    </span>
  );
}
