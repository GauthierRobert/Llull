// The "Cases" section of the Analysis panel: one row per analysis set up in the document.

import React from 'react';
import { ListRow, PanelEmpty, PanelSection } from '@ui/panels/PanelParts';
import type { AnalysisListItem } from './analysisData';
import { AnalysisStateBadge } from './AnalysisStateBadge';

interface AnalysisCaseListProps {
  list: readonly AnalysisListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function AnalysisCaseList({ list, selectedId, onSelect }: AnalysisCaseListProps): React.ReactElement {
  return (
    <PanelSection title="Cases" hint="Finite-element and thermal analyses set up in this document.">
      {list.length === 0 ? (
        <PanelEmpty
          compact
          icon="wireframe"
          message="No analyses yet"
          hint="Set up a finite-element or thermal case."
          action={{ label: 'New analysis', command: 'create_analysis' }}
        />
      ) : (
        <ul className="panel__list" aria-label="Analyses">
          {list.map((item) => (
            <ListRow
              key={item.id}
              testId={`analysis-row-${item.id}`}
              buttonTestId={`analysis-open-${item.id}`}
              selected={item.id === selectedId}
              current={item.id === selectedId}
              label={`Open analysis ${item.name}`}
              onSelect={() => onSelect(item.id)}
            >
              <span className="panel__row-main">{item.name}</span>
              <span className="panel__row-meta">
                {item.type} · <AnalysisStateBadge state={item.state} testId={`analysis-state-${item.id}`} />
              </span>
            </ListRow>
          ))}
        </ul>
      )}
    </PanelSection>
  );
}
