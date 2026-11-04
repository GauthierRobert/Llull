// Scan browser (read-only): the attached point clouds with their streaming state, and the view controls of the viewport (colour mode,
// point budget, crops, scan-point snap). Everything here is UI state (scanViewStore); clouds, crops and registrations are document data
// changed only by the scan commands (attach / set_scan_crop / apply_registration…), which the palette runs.

import React from 'react';
import '@ui/styles/panels/scan.css';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import { POINT_BUDGETS, useScanViewStore, type CloudStream, type ColourChoice } from '@ui/store/scanViewStore';
import { COLOUR_MODES, COLOUR_MODE_LABELS, type ColourMode } from '@ui/viewport/3d/scan/colourModes';
import type { CloudReference } from '@ui/viewport/3d/scan/cloudTypes';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import { type Kpi, KpiStrip, PanelEmpty, PanelHeader, PanelSection, StatusChip, type StatusTone } from '@ui/panels/PanelParts';

const STREAM_TONE: Readonly<Record<CloudStream['status'], StatusTone>> = {
  idle: 'info',
  offline: 'warn',
  loading: 'info',
  ready: 'ok',
  error: 'bad',
};
const STREAM_TEXT: Readonly<Record<CloudStream['status'], string>> = {
  idle: 'Idle',
  offline: 'No backend',
  loading: 'Loading',
  ready: 'Streaming',
  error: 'Error',
};

const count = (value: number): string => value.toLocaleString('en-US');
const budgetLabel = (budget: number): string => `${budget / 1_000_000} M points`;

function CloudRow({
  cloud,
  stream,
  registration,
}: {
  cloud: CloudReference;
  stream: CloudStream | undefined;
  registration: string | null;
}): React.ReactElement {
  const share = stream !== undefined && stream.pointCount ? Math.min(1, stream.drawn / stream.pointCount) : 0;
  return (
    <li className="panel__row scan__cloud" data-testid={`scan-cloud-${cloud.id}`}>
      <div className="scan__cloud-head">
        <span className="scan__cloud-name" title={cloud.name}>
          {cloud.name}
        </span>
        {!cloud.display.visible && <StatusChip tone="info" text="Hidden" />}
        {stream !== undefined && (
          <StatusChip tone={STREAM_TONE[stream.status]} text={STREAM_TEXT[stream.status]} testId={`scan-status-${cloud.id}`} />
        )}
      </div>
      {stream !== undefined && stream.message !== '' && <p className="panel__section-hint">{stream.message}</p>}
      <div className="scan__meter" role="img" aria-label={`${Math.round(share * 100)} percent of the points drawn`}>
        <div className="scan__meter-fill" style={{ width: `${share * 100}%` }} />
      </div>
      <div className="scan__meta">
        <span data-testid={`scan-points-${cloud.id}`}>
          {count(stream?.drawn ?? 0)} / {stream?.pointCount != null ? count(stream.pointCount) : '—'} points
        </span>
        <span>{cloud.placement === 'grid' ? 'Site grid' : 'Local'}</span>
        {registration !== null && <span>Registration {registration}</span>}
      </div>
    </li>
  );
}

export function ScanPanel({ className }: { className?: string }): React.ReactElement {
  const scan = useStore((s) => s.document.scan);
  const colourChoice = useScanViewStore((s) => s.colourChoice);
  const pointBudget = useScanViewStore((s) => s.pointBudget);
  const applyCrops = useScanViewStore((s) => s.applyCrops);
  const snapToScan = useScanViewStore((s) => s.snapToScan);
  const edl = useScanViewStore((s) => s.edl);
  const streams = useScanViewStore((s) => s.streams);
  const { setColourChoice, setPointBudget, toggleApplyCrops, toggleSnapToScan, toggleEdl } = useScanViewStore.getState();

  const clouds = (scan?.cloudOrder ?? []).flatMap((id) => {
    const cloud = scan?.clouds[id];
    return cloud === undefined ? [] : [cloud];
  });
  const cropCount = Object.keys(scan?.crops ?? {}).length;
  const drawn = clouds.reduce((sum, cloud) => sum + (streams[cloud.id]?.drawn ?? 0), 0);
  const loadedModes = new Set<ColourMode>(clouds.flatMap((cloud) => streams[cloud.id]?.modes ?? []));

  const kpis: Kpi[] = [
    { key: 'clouds', label: 'Clouds', value: String(clouds.length) },
    { key: 'drawn', label: 'Drawn', value: count(drawn), sub: `of ${budgetLabel(pointBudget)}` },
  ];
  const colourOptions: Array<readonly [string, string]> = [
    ['document', 'As attached'],
    ...COLOUR_MODES.map(
      (mode) => [mode, loadedModes.has(mode) ? COLOUR_MODE_LABELS[mode] : `${COLOUR_MODE_LABELS[mode]} (no data)`] as const,
    ),
  ];

  return (
    <aside className={classNames('panel', className)} aria-label="Scan" data-testid="scan-panel">
      <PanelHeader title="Scan" count={clouds.length} countLabel={`${clouds.length} point clouds`} />
      {clouds.length === 0 ? (
        <PanelEmpty
          icon="pointCloud"
          message="No point cloud attached"
          hint="Import a scan with the CLI, then attach it."
          action={{ label: 'Attach a cloud', command: 'attach_point_cloud' }}
        />
      ) : (
        <>
          <KpiStrip items={kpis} label="Scan summary" />
          <PanelSection title="Clouds" count={clouds.length}>
            <ul className="panel__list">
              {clouds.map((cloud) => {
                const record = cloud.registrationId === null ? undefined : scan?.registrations[cloud.registrationId];
                return <CloudRow key={cloud.id} cloud={cloud} stream={streams[cloud.id]} registration={record?.status ?? null} />;
              })}
            </ul>
          </PanelSection>
          <PanelSection title="View" hint="Presentation only: the document is not changed.">
            <div className="scan__controls">
              <LabeledSelect
                label="Colour by"
                value={colourChoice}
                options={colourOptions}
                testId="scan-colour"
                onChange={(value) => setColourChoice(value as ColourChoice)}
              />
              <LabeledSelect
                label="Point budget"
                value={String(pointBudget)}
                options={POINT_BUDGETS.map((budget) => [String(budget), budgetLabel(budget)] as const)}
                testId="scan-budget"
                onChange={(value) => setPointBudget(Number(value))}
              />
              <label className="loads-check scan__toggle">
                <input type="checkbox" checked={applyCrops} onChange={toggleApplyCrops} data-testid="scan-crops" />
                Apply crop boxes ({cropCount})
              </label>
              <label className="loads-check scan__toggle">
                <input type="checkbox" checked={snapToScan} onChange={toggleSnapToScan} data-testid="scan-snap" />
                Snap to scan points
              </label>
              <label className="loads-check scan__toggle">
                <input type="checkbox" checked={edl} onChange={toggleEdl} data-testid="scan-edl" />
                Eye-dome lighting (depth shading)
              </label>
            </div>
          </PanelSection>
        </>
      )}
    </aside>
  );
}
