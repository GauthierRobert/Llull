/**
 * @layer ui/panels/civil
 *
 * CivilExportsSection — LandXML (`export_landxml`) and civil DXF (`export_civil_dxf`) downloads.
 * Read-only: runs the exporters locally on the current document.
 */

import React, { useState } from 'react';
import { PanelSection } from '@ui/panels/PanelParts';
import { CivilStatus } from './CivilParts';
import { downloadQuery } from './civilQuery';

export function CivilExportsSection(): React.ReactElement {
  const [status, setStatus] = useState('');
  return (
    <PanelSection
      title="Exports"
      step={6}
      hint="LandXML for Civil 3D / 12d / Trimble, DXF with the TIN as 3D faces and contours at their elevation."
      collapsible
      testId="civil-exports"
    >
      <div className="building-actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() =>
            setStatus(downloadQuery('export_landxml', {}, 'text', 'site.xml', 'application/xml'))
          }
        >
          LandXML
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() =>
            setStatus(
              downloadQuery('export_civil_dxf', {}, 'text', 'site_civil.dxf', 'application/dxf'),
            )
          }
        >
          DXF (civil)
        </button>
      </div>
      <CivilStatus text={status} testId="civil-export-status" />
    </PanelSection>
  );
}
