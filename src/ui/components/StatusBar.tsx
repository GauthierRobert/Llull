/**
 * @layer ui/components
 *
 * StatusBar — slim bottom bar that surfaces live document state at a glance.
 *
 * Reads (all via narrow Zustand selectors — react R3):
 *   - liveStatus + syncState + hasUnsyncedLocalEdits → live / syncing / sync-failed indicator
 *   - document.units + document.displayPrecision → formatted unit label
 *   - document.order.length / document.selection.length → entity + selection counts
 *   - lastSummary                             → most recent command feedback
 *
 * Presentation ONLY. No document mutations (PRIME DIRECTIVE).
 */

import React from 'react';
import { useStore } from '@ui/store';

interface StatusItemProps {
  label: string;
  value: string;
  'aria-label'?: string;
}

function StatusItem({
  label,
  value,
  'aria-label': ariaLabel,
}: StatusItemProps): React.ReactElement {
  return (
    <span className="status-item" aria-label={ariaLabel ?? `${label}: ${value}`}>
      <span className="status-item__label">{label}</span>
      <span className="status-item__value">{value}</span>
    </span>
  );
}

function LiveIndicator(): React.ReactElement {
  const liveStatus = useStore((s) => s.liveStatus);
  const syncState = useStore((s) => s.syncState);
  const hasUnsynced = useStore((s) => s.hasUnsyncedLocalEdits);

  const label =
    liveStatus === 'connected'
      ? syncState === 'failed'
        ? 'Sync failed — retrying'
        : syncState === 'syncing' || hasUnsynced
          ? 'Syncing…'
          : 'Live'
      : liveStatus === 'connecting'
        ? 'Connecting…'
        : 'Offline (local)';

  return (
    <span
      className={`live-indicator live-indicator--${liveStatus}`}
      aria-label={`MCP stream: ${label}`}
      title={`MCP live stream: ${label}`}
    >
      <span className="live-indicator__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function StatusBar(): React.ReactElement {
  const units = useStore((s) => s.document.units);
  const displayPrecision = useStore((s) => s.document.displayPrecision);
  const entityCount = useStore((s) => s.document.order.length);
  const selectionCount = useStore((s) => s.document.selection.length);
  const lastSummary = useStore((s) => s.lastSummary);

  const unitLabel = `${units} (${displayPrecision}dp)`;
  const entityLabel = `${entityCount}`;
  const selectionLabel =
    selectionCount === 0
      ? 'None'
      : selectionCount === 1
        ? '1 entity'
        : `${selectionCount} entities`;

  return (
    <footer className="status-bar-bottom" aria-label="Document status">
      <div className="status-bar-bottom__items">
        <LiveIndicator />
        {lastSummary !== null && (
          <span
            className="status-summary"
            aria-live="polite"
            aria-label={`Last command: ${lastSummary}`}
            title={lastSummary}
          >
            {lastSummary}
          </span>
        )}
      </div>
      <div className="status-bar-bottom__right">
        <StatusItem label="Entities" value={entityLabel} aria-label={`Entities: ${entityLabel}`} />
        <span className="status-divider" aria-hidden="true" />
        <StatusItem
          label="Selection"
          value={selectionLabel}
          aria-label={`Selection: ${selectionLabel}`}
        />
        <span className="status-divider" aria-hidden="true" />
        <StatusItem label="Units" value={unitLabel} aria-label={`Units: ${unitLabel}`} />
      </div>
    </footer>
  );
}
