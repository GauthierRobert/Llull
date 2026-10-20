// Bottom bar: live / connecting / offline, last summary, entity + selection counts, units.

import React from 'react';
import { useStore } from '@ui/store';
import { useKernelStatusStore } from '@ui/store/kernelStatus';
import { useFailureStore } from '@ui/report/failureStore';

function StatusItem({
  label,
  value,
  'aria-label': ariaLabel,
}: {
  label: string;
  value: string;
  'aria-label'?: string;
}): React.ReactElement {
  return (
    <span className="status-item" aria-label={ariaLabel ?? `${label}: ${value}`}>
      <span className="status-item__label">{label}</span>
      <span className="status-item__value">{value}</span>
    </span>
  );
}

function LiveIndicator(): React.ReactElement {
  const liveStatus = useStore((s) => s.liveStatus);

  const label = liveStatus === 'connected' ? 'Live' : liveStatus === 'connecting' ? 'Connecting…' : 'Offline (local)';

  return (
    <span className={`live-indicator live-indicator--${liveStatus}`} aria-label={`Live sync: ${label}`} title={`Live sync: ${label}`}>
      <span className="live-indicator__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Hidden once the kernel is ready; solid/boolean commands do nothing until then. */
function KernelIndicator(): React.ReactElement | null {
  const status = useKernelStatusStore((s) => s.status);
  if (status === 'ready') return null;
  const label =
    status === 'loading'
      ? 'Loading geometry kernel…'
      : 'Geometry kernel failed to load — 3D solid operations are unavailable. Reload to retry.';
  return (
    <span className={`status-summary status-kernel status-kernel--${status}`} role={status === 'failed' ? 'alert' : 'status'} title={label}>
      {label}
    </span>
  );
}

/** Offered only while the status text is the summary of an internal failure (not for invalid params, guards or "not supported"). */
function ReportOffer(): React.ReactElement | null {
  const failure = useFailureStore((s) => s.failure);
  const openDialog = useFailureStore((s) => s.openDialog);
  const lastSummary = useStore((s) => s.lastSummary);
  if (failure === null || failure.summary !== lastSummary) return null;
  return (
    <button type="button" className="status-report-link" onClick={openDialog} title="Review and report this internal error">
      Report this…
    </button>
  );
}

export function StatusBar(): React.ReactElement {
  const units = useStore((s) => s.document.units);
  const displayPrecision = useStore((s) => s.document.displayPrecision);
  const entityCount = useStore((s) => s.document.order.length);
  // Building commands also put element ids in the selection; count only real entities.
  const selectionCount = useStore((s) => s.document.selection.filter((id) => id in s.document.entities).length);
  const lastSummary = useStore((s) => s.lastSummary);

  const unitLabel = `${units} (${displayPrecision}dp)`;
  const entityLabel = `${entityCount}`;
  const selectionLabel = selectionCount === 0 ? 'None' : selectionCount === 1 ? '1 entity' : `${selectionCount} entities`;

  return (
    <footer className="status-bar-bottom" aria-label="Document status">
      <div className="status-bar-bottom__items">
        <LiveIndicator />
        <KernelIndicator />
        {lastSummary !== null && (
          <span
            key={lastSummary}
            className="status-summary"
            aria-live="polite"
            aria-label={`Last command: ${lastSummary}`}
            title={lastSummary}
          >
            {lastSummary}
          </span>
        )}
        <ReportOffer />
      </div>
      <div className="status-bar-bottom__right">
        <StatusItem label="Entities" value={entityLabel} aria-label={`Entities: ${entityLabel}`} />
        <span className="status-divider" aria-hidden="true" />
        <StatusItem label="Selection" value={selectionLabel} aria-label={`Selection: ${selectionLabel}`} />
        <span className="status-divider" aria-hidden="true" />
        <StatusItem label="Units" value={unitLabel} aria-label={`Units: ${unitLabel}`} />
      </div>
    </footer>
  );
}
