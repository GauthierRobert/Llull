/**
 * @layer ui/panels/building
 *
 * BuildingExportsSection — downloads of the read-only exporters: DXF plan, IFC4 model and the
 * printable SVG plan sheet (paper + scale). Presentation + download only.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { execute } from '@core/commands/registry';
import { PanelSection } from '@ui/panels/PanelParts';
import { downloadText } from '@ui/download';

const PAPERS = ['A4', 'A3', 'A2', 'A1', 'A0'] as const;
const SCALES = ['auto', '20', '50', '100', '200', '500'] as const;

export function BuildingExportsSection(): React.ReactElement {
  const document = useStore((s) => s.document);
  const [paper, setPaper] = useState<(typeof PAPERS)[number]>('A3');
  const [scale, setScale] = useState<(typeof SCALES)[number]>('auto');
  const [status, setStatus] = useState('');

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
            run(
              'export_plan_sheet',
              { paper, ...(scale === 'auto' ? {} : { scale: Number(scale) }) },
              'svg',
              'image/svg+xml',
            )
          }
        >
          Plan sheet
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
