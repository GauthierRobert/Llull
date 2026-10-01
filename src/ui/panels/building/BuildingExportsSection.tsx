/**
 * @layer ui/panels/building
 *
 * BuildingExportsSection — downloads of the read-only exporters: DXF plan, IFC4 model, the
 * printable SVG plan sheet and elevation / section sheets (paper + scale). Presentation only.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { execute } from '@core/commands/registry';
import { PanelSection } from '@ui/panels/PanelParts';
import { downloadText } from '@ui/download';

const PAPERS = ['A4', 'A3', 'A2', 'A1', 'A0'] as const;
const SCALES = ['auto', '20', '50', '100', '200', '500'] as const;
const DIRECTIONS = ['south', 'north', 'east', 'west'] as const;

export function BuildingExportsSection(): React.ReactElement {
  const document = useStore((s) => s.document);
  const [paper, setPaper] = useState<(typeof PAPERS)[number]>('A3');
  const [scale, setScale] = useState<(typeof SCALES)[number]>('auto');
  const [status, setStatus] = useState('');
  const [direction, setDirection] = useState<(typeof DIRECTIONS)[number]>('south');
  const [cutAt, setCutAt] = useState('');
  const [hideCladding, setHideCladding] = useState(false);
  const scaleParams = scale === 'auto' ? {} : { scale: Number(scale) };

  const run = (
    command: string,
    params: Record<string, unknown>,
    field: string,
    mimeType: string,
  ): void => {
    const result = execute(document, command, params);
    const data = result.data as Record<string, string> | undefined;
    const content = data?.[field];
    const fileName = data?.['filename'];
    if (content !== undefined && fileName !== undefined) downloadText(content, fileName, mimeType);
    setStatus(result.summary);
  };

  return (
    <PanelSection title="Deliverables" collapsible testId="building-exports">
      <div className="building-inline-form">
        <select
          value={paper}
          onChange={(event) => setPaper(event.target.value as (typeof PAPERS)[number])}
          aria-label="Paper size"
        >
          {PAPERS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <select
          value={scale}
          onChange={(event) => setScale(event.target.value as (typeof SCALES)[number])}
          aria-label="Drawing scale"
        >
          {SCALES.map((value) => (
            <option key={value} value={value}>
              {value === 'auto' ? 'Fit scale' : `1:${value}`}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() =>
            run('export_plan_sheet', { paper, ...scaleParams }, 'svg', 'image/svg+xml')
          }
        >
          Plan sheet
        </button>
      </div>
      <div className="building-inline-form">
        <select
          value={direction}
          onChange={(event) => setDirection(event.target.value as (typeof DIRECTIONS)[number])}
          aria-label="Elevation direction"
        >
          {DIRECTIONS.map((value) => (
            <option key={value} value={value}>
              {value[0]?.toUpperCase()}
              {value.slice(1)}
            </option>
          ))}
        </select>
        <input
          type="number"
          value={cutAt}
          placeholder="Cut at (section)"
          onChange={(event) => setCutAt(event.target.value)}
          aria-label="Section cut position"
        />
        <label className="field">
          <input
            type="checkbox"
            checked={hideCladding}
            onChange={(event) => setHideCladding(event.target.checked)}
          />
          <span>Hide cladding</span>
        </label>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() =>
            run(
              'export_elevation_sheet',
              {
                direction,
                paper,
                ...scaleParams,
                ...(cutAt.trim() !== '' && Number.isFinite(Number(cutAt))
                  ? { cutAt: Number(cutAt) }
                  : {}),
                ...(hideCladding ? { exclude: ['panel'] } : {}),
              },
              'svg',
              'image/svg+xml',
            )
          }
        >
          {cutAt.trim() === '' ? 'Elevation sheet' : 'Section sheet'}
        </button>
      </div>
      <div className="building-actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => run('export_dxf', {}, 'dxf', 'application/dxf')}
        >
          DXF (AutoCAD)
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => run('export_ifc', {}, 'ifc', 'application/x-step')}
        >
          IFC (BIM)
        </button>
      </div>
      {status !== '' && (
        <p className="building-summary" role="status" data-testid="building-export-status">
          {status}
        </p>
      )}
    </PanelSection>
  );
}
