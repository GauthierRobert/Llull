/**
 * @layer ui/panels/building
 *
 * BuildingExportsSection — downloads of the read-only exporters: DXF plan, IFC4 model, the
 * printable SVG plan sheet, elevation / section sheets and anchor bolt plan (paper + scale) and
 * DSTV NC1 fabrication files (one download per part). Presentation only.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { execute } from '@core/commands/registry';
import { isNcFilesData, stringFields } from '@ui/resultData';
import { PanelSection } from '@ui/panels/PanelParts';
import { OptionSelect } from '@ui/panels/OptionSelect';
import { capitalize } from '@ui/panels/capitalize';
import { orderedValues } from '@ui/panels/orderedValues';
import { downloadText } from '@ui/download';

const PAPERS = ['A4', 'A3', 'A2', 'A1', 'A0'] as const;
const SCALES = ['auto', '20', '50', '100', '200', '500'] as const;
const DIRECTIONS = ['south', 'north', 'east', 'west'] as const;

export function BuildingExportsSection(): React.ReactElement {
  const building = useStore((s) => s.document.building);
  const [paper, setPaper] = useState<(typeof PAPERS)[number]>('A3');
  const [scale, setScale] = useState<(typeof SCALES)[number]>('auto');
  const [status, setStatus] = useState('');
  const [direction, setDirection] = useState<(typeof DIRECTIONS)[number]>('south');
  const [cutAt, setCutAt] = useState('');
  const [hideCladding, setHideCladding] = useState(false);
  const [levelChoice, setLevelChoice] = useState('');
  const levels = building ? orderedValues(building.levelOrder, building.levels) : [];
  const levelParams =
    levelChoice !== '' && levels.some((level) => level.id === levelChoice)
      ? { levelId: levelChoice }
      : {};
  const scaleParams = scale === 'auto' ? {} : { scale: Number(scale) };

  const run = (
    command: string,
    params: Record<string, unknown>,
    field: string,
    mimeType: string,
  ): void => {
    const result = execute(useStore.getState().document, command, params);
    const data = stringFields(result.data);
    const content = data?.[field];
    const fileName = data?.['filename'];
    if (content !== undefined && fileName !== undefined) downloadText(content, fileName, mimeType);
    setStatus(result.summary);
  };

  const exportNcFiles = (): void => {
    const result = execute(useStore.getState().document, 'export_nc_files', {});
    const files = isNcFilesData(result.data) ? result.data.files : [];
    for (const file of files) downloadText(file.content, file.name, 'text/plain');
    setStatus(result.summary);
  };

  return (
    <PanelSection title="Deliverables" collapsible testId="building-exports">
      <div className="building-inline-form">
        <OptionSelect value={paper} options={PAPERS} label="Paper size" onChange={setPaper} />
        <OptionSelect
          value={scale}
          options={SCALES}
          label="Drawing scale"
          optionLabel={(value) => (value === 'auto' ? 'Fit scale' : `1:${value}`)}
          onChange={setScale}
        />
        <select
          value={levelParams.levelId ?? ''}
          onChange={(event) => setLevelChoice(event.target.value)}
          aria-label="Export level"
          title="Level printed by the plan sheet, anchor plan and DXF"
        >
          <option value="">Active level</option>
          {levels.map((level) => (
            <option key={level.id} value={level.id}>
              {level.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() =>
            run(
              'export_plan_sheet',
              { paper, ...scaleParams, ...levelParams },
              'svg',
              'image/svg+xml',
            )
          }
        >
          Plan sheet
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() =>
            run(
              'export_anchor_plan',
              { paper, ...scaleParams, ...levelParams },
              'svg',
              'image/svg+xml',
            )
          }
        >
          Anchor plan
        </button>
      </div>
      <div className="building-inline-form">
        <OptionSelect
          value={direction}
          options={DIRECTIONS}
          label="Elevation direction"
          optionLabel={capitalize}
          onChange={setDirection}
        />
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
          onClick={() => run('export_dxf', { ...levelParams }, 'dxf', 'application/dxf')}
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
        <button type="button" className="btn btn--ghost btn--sm" onClick={exportNcFiles}>
          NC files (DSTV)
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
