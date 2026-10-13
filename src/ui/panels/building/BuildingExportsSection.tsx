/**
 * @layer ui/panels/building
 *
 * BuildingExportsSection — downloads of the read-only exporters: DXF plan, IFC4 model, the
 * printable SVG plan sheet, elevation / section sheets and anchor bolt plan (paper + scale) and
 * DSTV NC1 fabrication files (one download per part). Presentation only.
 */

import React, { useState } from 'react';
import { PAPER_SIZES } from '@aec/shared/sheetFrame';
import { isNcFilesData } from '@ui/resultData';
import { runQuery } from '@ui/services/localQuery';
import { PanelSection, StatusLine } from '@ui/panels/PanelParts';
import { QueryDownloadButton } from '@ui/panels/QueryDownloadButton';
import { OptionSelect } from '@ui/panels/OptionSelect';
import { capitalize } from '@ui/panels/capitalize';
import { downloadText } from '@ui/download';
import { optionalNumber } from '@ui/numberText';
import { LevelSelect } from './LevelSelect';
import { useBuildingLevels } from './useBuildingLevels';

const SCALES = ['auto', '20', '50', '100', '200', '500'] as const;
const DIRECTIONS = ['south', 'north', 'east', 'west'] as const;

export function BuildingExportsSection(): React.ReactElement {
  const levels = useBuildingLevels();
  const [paper, setPaper] = useState<(typeof PAPER_SIZES)[number]>('A3');
  const [scale, setScale] = useState<(typeof SCALES)[number]>('auto');
  const [status, setStatus] = useState('');
  const [direction, setDirection] = useState<(typeof DIRECTIONS)[number]>('south');
  const [cutAt, setCutAt] = useState('');
  const [hideCladding, setHideCladding] = useState(false);
  const [levelChoice, setLevelChoice] = useState('');
  const levelParams = levelChoice !== '' && levels.some((level) => level.id === levelChoice) ? { levelId: levelChoice } : {};
  const scaleParams = scale === 'auto' ? {} : { scale: Number(scale) };

  const exportNcFiles = (): void => {
    const result = runQuery('export_nc_files');
    const files = isNcFilesData(result.data) ? result.data.files : [];
    for (const file of files) downloadText(file.content, file.name, 'text/plain');
    setStatus(result.summary);
  };

  return (
    <PanelSection
      title="Deliverables"
      step={5}
      hint="Drawing sheets (plan, elevations) and files for other software: DXF for AutoCAD, IFC for BIM, DSTV for the fabricator."
      collapsible
      testId="building-exports"
    >
      <div className="building-inline-form">
        <OptionSelect value={paper} options={PAPER_SIZES} label="Paper size" onChange={setPaper} />
        <OptionSelect
          value={scale}
          options={SCALES}
          label="Drawing scale"
          optionLabel={(value) => (value === 'auto' ? 'Fit scale' : `1:${value}`)}
          onChange={setScale}
        />
        <LevelSelect
          levels={levels}
          value={levelParams.levelId ?? ''}
          label="Export level"
          title="Level printed by the plan sheet, anchor plan and DXF"
          blankLabel="Active level"
          onChange={setLevelChoice}
        />
        <QueryDownloadButton
          primary
          label="Plan sheet"
          command="export_plan_sheet"
          params={{ paper, ...scaleParams, ...levelParams }}
          field="svg"
          fallbackName={null}
          mimeType="image/svg+xml"
          onStatus={setStatus}
        />
        <QueryDownloadButton
          label="Anchor plan"
          command="export_anchor_plan"
          params={{ paper, ...scaleParams, ...levelParams }}
          field="svg"
          fallbackName={null}
          mimeType="image/svg+xml"
          onStatus={setStatus}
        />
      </div>
      <div className="building-inline-form">
        <OptionSelect value={direction} options={DIRECTIONS} label="Elevation direction" optionLabel={capitalize} onChange={setDirection} />
        <input
          type="number"
          value={cutAt}
          placeholder="Cut at (section)"
          onChange={(event) => setCutAt(event.target.value)}
          aria-label="Section cut position"
        />
        <label className="field">
          <input type="checkbox" checked={hideCladding} onChange={(event) => setHideCladding(event.target.checked)} />
          <span>Hide cladding</span>
        </label>
        <QueryDownloadButton
          primary
          label={cutAt.trim() === '' ? 'Elevation sheet' : 'Section sheet'}
          command="export_elevation_sheet"
          params={{
            direction,
            paper,
            ...scaleParams,
            ...optionalNumber('cutAt', cutAt),
            ...(hideCladding ? { exclude: ['panel'] } : {}),
          }}
          field="svg"
          fallbackName={null}
          mimeType="image/svg+xml"
          onStatus={setStatus}
        />
      </div>
      <div className="building-actions">
        <QueryDownloadButton
          label="DXF (AutoCAD)"
          command="export_dxf"
          params={{ ...levelParams }}
          field="dxf"
          fallbackName={null}
          mimeType="application/dxf"
          onStatus={setStatus}
        />
        <QueryDownloadButton
          label="IFC (BIM)"
          command="export_ifc"
          field="ifc"
          fallbackName={null}
          mimeType="application/x-step"
          onStatus={setStatus}
        />
        <button type="button" className="btn btn--ghost btn--sm" onClick={exportNcFiles}>
          NC files (DSTV)
        </button>
      </div>
      <StatusLine text={status} testId="building-export-status" />
    </PanelSection>
  );
}
