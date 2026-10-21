// Civil object row with its live read-only report, one number field and one action (contour interval, swell factor).

import React, { useState } from 'react';
import type { CivilObject } from '@aec/index';
import { CivilObjectRow, NumberTextField } from './CivilParts';
import { useCivilReport } from './civilQuery';

interface CivilReportRowProps {
  object: CivilObject;
  /** Read-only command (and its id param name) whose summary is shown under the row. */
  report: { readonly command: string; readonly idKey: string };
  field: { readonly hint: string; readonly label: string };
  action: {
    readonly label: string;
    readonly title?: string;
    /** Receives the field text; returns true when it was applied and the field should clear. */
    readonly run: (text: string) => boolean;
  };
}

export function CivilReportRow({ object, report, field, action }: CivilReportRowProps): React.ReactElement {
  const [text, setText] = useState('');
  const detail = useCivilReport(report.command, report.idKey, object.id);
  return (
    <CivilObjectRow object={object} detail={detail}>
      <NumberTextField value={text} set={setText} hint={field.hint} label={field.label} />
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        title={action.title}
        onClick={() => {
          if (action.run(text)) setText('');
        }}
      >
        {action.label}
      </button>
    </CivilObjectRow>
  );
}
