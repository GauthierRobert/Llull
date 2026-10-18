// Modal / buckling results: the numbered list of natural frequencies (Hz) or buckling factors recorded with the solved case.
// Each row selects the mode drawn by the results plot.

import React from 'react';
import { classNames } from '@ui/classNames';
import { PanelSection } from '@ui/panels/PanelParts';
import { EIGEN_FIGURES, formatSignificant } from './quantityFormat';
import type { EigenView } from './analysisData';

interface AnalysisModesProps {
  eigen: EigenView;
  /** The mode (1-based) the results plot shows. */
  selectedMode: number;
  onSelect: (mode: number) => void;
}

export function AnalysisModes({ eigen, selectedMode, onSelect }: AnalysisModesProps): React.ReactElement {
  return (
    <PanelSection title={eigen.label} hint="Pick a mode to plot its shape.">
      <ol className="analysis__items" aria-label={eigen.label} data-testid="analysis-modes">
        {eigen.values.map((value, index) => {
          const mode = index + 1;
          const selected = mode === selectedMode;
          return (
            <li key={mode} className="analysis__mode-row">
              <button
                type="button"
                className={classNames('analysis__item analysis__item--button', selected && 'analysis__item--selected')}
                aria-pressed={selected}
                data-testid={`analysis-mode-${mode}`}
                onClick={() => onSelect(mode)}
              >
                <span className="analysis__item-name">Mode {mode}</span>
                <span className="analysis__item-detail">
                  {formatSignificant(value, EIGEN_FIGURES)} {eigen.unit}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </PanelSection>
  );
}
