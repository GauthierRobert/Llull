// Per load case peaks of a solved structural case (max von Mises, max displacement), in the case's unit system.

import React from 'react';
import type { AnalysisCase } from '@core/model/analysis';
import { lengthUnitName, stressUnitName } from '@cae/decks/units';
import { PanelSection } from '@ui/panels/PanelParts';
import { formatQuantities, formatSignificant } from './quantityFormat';

export function AnalysisResultSummary({ analysisCase }: { analysisCase: AnalysisCase }): React.ReactElement | null {
  const loadCases = Array.isArray(analysisCase.results?.loadCases) ? analysisCase.results.loadCases : [];
  if (loadCases.length === 0) return null;
  const stressUnit = stressUnitName(analysisCase.unitSystem);
  const lengthUnit = lengthUnitName(analysisCase.unitSystem);
  const stresses = formatQuantities(
    loadCases.map((entry) => entry.maxVonMises.value),
    stressUnit,
  );
  return (
    <PanelSection title="Results summary" hint={`Peaks per load case (${analysisCase.unitSystem}).`}>
      <ul className="analysis__items" aria-label="Load case results" data-testid="analysis-result-summary">
        {loadCases.map((entry, index) => (
          <li key={entry.name} className="analysis__item">
            <span className="analysis__item-name">
              {entry.name} <span className="analysis__item-detail">({entry.category})</span>
            </span>
            <span className="analysis__item-detail">
              max von Mises {stresses.texts[index]} {stresses.unit} · max displacement {formatSignificant(entry.maxDisplacement.value)}{' '}
              {lengthUnit}
            </span>
          </li>
        ))}
      </ul>
    </PanelSection>
  );
}
