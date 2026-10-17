// check_analysis outcome: pass / warn / fail status and its items.

import React from 'react';
import { PanelSection, StatusLine } from '@ui/panels/PanelParts';
import { classNames } from '@ui/classNames';
import type { CheckView } from './analysisData';

const STATUS_TEXT: Readonly<Record<CheckView['status'], string>> = { pass: 'Ready', warn: 'Warnings', fail: 'Problems found' };

export function AnalysisChecks({ check, summary }: { check: CheckView | null; summary: string }): React.ReactElement {
  return (
    <PanelSection title="Checks" hint="check_analysis: readiness and consistency. Not a certification; a qualified person must review.">
      {check === null ? (
        <StatusLine text={summary} testId="analysis-check-summary" />
      ) : (
        <>
          <p className={classNames('analysis__badge', `analysis__badge--${check.status}`)} data-testid="analysis-check-status">
            {check.status} · {STATUS_TEXT[check.status]}
          </p>
          <ul className="analysis__items" aria-label="Check items">
            {check.items.map((item, index) => (
              <li key={`${item.code}-${index}`} className={classNames('analysis__item', `analysis__item--${item.severity}`)}>
                <span className="analysis__item-name">{item.code}</span>
                <span className="analysis__item-detail">
                  {item.message}
                  {item.remediation !== '' ? ` — ${item.remediation}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </PanelSection>
  );
}
