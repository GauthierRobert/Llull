// "Where does this come from?" popover: a native <details> (keyboard + screen-reader friendly, no focus trap needed).

import React from 'react';

export interface ProvenanceEntry {
  readonly label: string;
  readonly value: string;
}

interface ProvenancePopoverProps {
  readonly title?: string;
  readonly entries: readonly ProvenanceEntry[];
  readonly testId?: string;
}

export function ProvenancePopover({ title = 'Provenance', entries, testId }: ProvenancePopoverProps): React.ReactElement | null {
  if (entries.length === 0) return null;
  return (
    <details className="provenance" data-testid={testId}>
      <summary className="provenance__toggle" aria-label={title}>
        {title}
      </summary>
      <dl className="provenance__body">
        {entries.map((entry, index) => (
          <React.Fragment key={`${entry.label}-${index}`}>
            <dt>{entry.label}</dt>
            <dd>{entry.value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </details>
  );
}
