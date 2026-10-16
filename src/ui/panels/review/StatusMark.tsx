// Status as icon shape + word (✔ ▲ ✖ ○ ◌): never colour alone (FR-FPR-60).

import React from 'react';
import { STATUS_GLYPH, STATUS_WORD, type DisplayStatus } from './checklist';

interface StatusMarkProps {
  readonly status: DisplayStatus;
  /** Replaces the plain status word, e.g. "fail (accepted)". */
  readonly label?: string;
}

export function StatusMark({ status, label }: StatusMarkProps): React.ReactElement {
  return (
    <span className={`status-mark status-mark--${status}`} data-status={status}>
      <span className="status-mark__glyph" aria-hidden="true">
        {STATUS_GLYPH[status]}
      </span>
      <span className="status-mark__word">{label ?? STATUS_WORD[status]}</span>
    </span>
  );
}
