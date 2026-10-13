/**
 * CivilExportsSection — LandXML (`export_landxml`) and civil DXF (`export_civil_dxf`) downloads.
 * Read-only: runs the exporters locally on the current document.
 */

import React, { useState } from 'react';
import { PAPER_SIZES, type PaperSize } from '@aec/shared/sheetFrame';
import { PanelSection, StatusLine } from '@ui/panels/PanelParts';
import { QueryDownloadButton } from '@ui/panels/QueryDownloadButton';
import { OptionSelect } from '@ui/panels/OptionSelect';
import { NumberTextField } from './CivilParts';
import { optionalNumber } from '@ui/numberText';

export function CivilExportsSection(): React.ReactElement {
  const [status, setStatus] = useState('');
  const [paper, setPaper] = useState<PaperSize>('A3');
  const [scale, setScale] = useState('');
  return (
    <PanelSection
      title="Exports"
      step={6}
      hint="LandXML for Civil 3D / 12d / Trimble, DXF with the TIN as 3D faces and contours at their elevation."
      collapsible
      testId="civil-exports"
    >
      <div className="building-actions">
        <QueryDownloadButton
          primary
          label="LandXML"
          command="export_landxml"
          field="text"
          fallbackName="site.xml"
          mimeType="application/xml"
          onStatus={setStatus}
        />
        <QueryDownloadButton
          label="DXF (civil)"
          command="export_civil_dxf"
          field="text"
          fallbackName="site_civil.dxf"
          mimeType="application/dxf"
          onStatus={setStatus}
        />
      </div>
      <div className="building-inline-form">
        <OptionSelect value={paper} options={PAPER_SIZES} label="Sheet paper" onChange={setPaper} />
        <NumberTextField value={scale} set={setScale} hint="Scale 1:N (auto)" label="Sheet scale" />
        <QueryDownloadButton
          label="Plan sheet"
          command="export_civil_plan_sheet"
          params={{ paper, ...optionalNumber('scale', scale) }}
          field="text"
          fallbackName="civil_plan.svg"
          mimeType="image/svg+xml"
          onStatus={setStatus}
        />
      </div>
      <StatusLine text={status} testId="civil-export-status" />
    </PanelSection>
  );
}
