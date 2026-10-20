// Overlay of the last `verify_exchange_file` result (read-only commands leave their data in `lastMeasure`); close clears it.

import React from 'react';
import { useStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { VerifyReportCard, parseVerifyReport } from '@ui/panels/exchange/ExchangeReport';

export function ExchangeReportHUD(): React.ReactElement | null {
  const lastMeasure = useStore((s) => s.lastMeasure);
  const clearLastMeasure = useStore((s) => s.clearLastMeasure);
  if (lastMeasure?.command !== 'verify_exchange_file') return null;
  const report = parseVerifyReport(lastMeasure.data);
  if (report === null) return null;
  return (
    <div className="mhud mhud--exchange" role="region" aria-label="Measurement result: exchange file">
      <div className="mhud-header">
        <span className="mhud-title">
          <Icon name="ruler" size={14} />
          Exchange file
        </span>
        <button type="button" className="mhud-dismiss" onClick={clearLastMeasure} aria-label="Dismiss exchange report" title="Dismiss">
          <Icon name="close" size={12} />
        </button>
      </div>
      <div className="mhud-body">
        <VerifyReportCard report={report} />
      </div>
    </div>
  );
}
