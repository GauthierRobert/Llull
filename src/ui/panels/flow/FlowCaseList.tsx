// The flow cases of the document: id, free stream and state badge; selecting one opens it below and draws it on the model.

import React from 'react';
import { useStore } from '@ui/store';
import { DeleteButton, ListRow, StatusChip } from '@ui/panels/PanelParts';
import { caseBadge, num, type FlowCase, type FlowReport, type FlowResult } from './flowData';

interface FlowCaseListProps {
  cases: Readonly<Record<string, FlowCase>>;
  results: Readonly<Record<string, FlowResult>>;
  selectedId: string | null;
  /** Report of the selected case (the badge of the others needs no report: stale shows once they are opened). */
  report: FlowReport | null;
  onSelect(caseId: string): void;
}

const streamText = (cfdCase: FlowCase): string => {
  const { mach, speedMS, alphaDeg } = cfdCase.freestream;
  const speed = mach !== undefined ? `Mach ${num(mach)}` : speedMS !== undefined ? `${num(speedMS)} m/s` : '';
  return `${speed}${alphaDeg === 0 ? '' : `, α ${num(alphaDeg)}°`}`;
};

export function FlowCaseList({ cases, results, selectedId, report, onSelect }: FlowCaseListProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  return (
    <ul className="panel__list" aria-label="Flow cases" data-testid="flow-cases">
      {Object.values(cases).map((cfdCase) => {
        const badge = caseBadge(results[cfdCase.id], cfdCase.id === selectedId ? report : null);
        return (
          <ListRow
            key={cfdCase.id}
            testId={`flow-case-${cfdCase.id}`}
            selected={cfdCase.id === selectedId}
            current={cfdCase.id === selectedId}
            onSelect={() => onSelect(cfdCase.id)}
            label={`Flow case ${cfdCase.id}`}
            actions={
              <DeleteButton
                label={`Delete flow case ${cfdCase.id}`}
                testId={`flow-delete-${cfdCase.id}`}
                onDelete={() => dispatch('delete_cfd_case', { caseId: cfdCase.id })}
              />
            }
          >
            <span className="panel__row-main">{cfdCase.id}</span>
            <span className="panel__row-meta">
              {cfdCase.entityIds.length} {cfdCase.entityIds.length === 1 ? 'body' : 'bodies'}
              {streamText(cfdCase) === '' ? '' : `, ${streamText(cfdCase)}`}
            </span>
            <StatusChip tone={badge.tone} text={badge.text} />
          </ListRow>
        );
      })}
    </ul>
  );
}
