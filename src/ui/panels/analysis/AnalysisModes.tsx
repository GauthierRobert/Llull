// Modal / buckling results: the numbered list of natural frequencies (Hz) or buckling factors recorded with the solved case.

import React from 'react';
import { PanelSection } from '@ui/panels/PanelParts';
import type { EigenView } from './analysisData';

const round = (n: number): string => String(Math.round(n * 1e4) / 1e4);

export function AnalysisModes({ eigen }: { eigen: EigenView }): React.ReactElement {
  return (
    <PanelSection title={eigen.label} hint="Mode numbers match the Mode control of the results plot.">
      <ol className="analysis__items" aria-label={eigen.label} data-testid="analysis-modes">
        {eigen.values.map((value, index) => (
          <li key={index} className="analysis__item">
            <span className="analysis__item-name">Mode {index + 1}</span>
            <span className="analysis__item-detail">
              {round(value)} {eigen.unit}
            </span>
          </li>
        ))}
      </ol>
    </PanelSection>
  );
}
