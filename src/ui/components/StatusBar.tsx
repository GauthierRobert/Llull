/**
 * @layer ui/components
 *
 * StatusBar — slim bottom bar: live / syncing / sync-failed indicator, last command summary,
 * entity + selection counts, units. Presentation only (PRIME DIRECTIVE).
 */

import React, { useEffect, useState } from 'react';
import { useStore } from '@ui/store';
import { SERVER_BASE } from '@ui/serverConfig';

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

/** License mode from the public `GET /license`; renders nothing offline / on any failure. */
function LicenseBadge(): React.ReactElement | null {
  const liveStatus = useStore((s) => s.liveStatus);
  const [license, setLicense] = useState<string | null>(null);

  useEffect(() => {
    if (liveStatus !== 'connected' || typeof fetch !== 'function') {
      setLicense(null);
      return;
    }
    let cancelled = false;
    fetch(`${SERVER_BASE}/license`)
      .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
      .then((body) => {
        const label = (body as { label?: unknown } | null)?.label;
        if (!cancelled && typeof label === 'string') setLicense(label);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [liveStatus]);

  if (license === null) return null;
  return (
    <>
      <StatusItem label="License" value={license} />
      <span className="status-divider" aria-hidden="true" />
    </>
  );
}

export function StatusBar(): React.ReactElement {
  const units = useStore((s) => s.document.units);
  const displayPrecision = useStore((s) => s.document.displayPrecision);
  const entityCount = useStore((s) => s.document.order.length);
  // Building commands also put element ids in the selection; count only real entities.
  const selectionCount = useStore(
    (s) => s.document.selection.filter((id) => id in s.document.entities).length,
  );
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
        <LicenseBadge />
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
