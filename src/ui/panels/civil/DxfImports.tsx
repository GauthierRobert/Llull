/**
 * DXF file inputs: survey points from a DXF (`import_survey_dxf`: POINTs, blocks, 3D polylines)
 * and a general drawing import (`import_dxf`). Reads the file as text, then dispatches.
 */

import React, { useState } from 'react';
import type { DocumentUnit } from '@core/model/types';
import type { DwgImportTarget } from '@mcp/restProtocol';
import { useStore } from '@ui/store';
import { fileStem } from '@ui/chosenFile';
import { FileField } from '@ui/panels/FileField';
import { StatusLine } from '@ui/panels/PanelParts';
import { useIsMounted } from '@ui/hooks/useIsMounted';
import { uploadDwg } from '@ui/services/serverFiles';

export function DxfImports({ unit }: { unit: DocumentUnit }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [dwgStatus, setDwgStatus] = useState('');
  const isMounted = useIsMounted();
  const importDwg = (file: File, target: DwgImportTarget): void => {
    setDwgStatus(`Converting ${file.name}…`);
    void uploadDwg(file, target, unit).then((status) => {
      if (isMounted()) setDwgStatus(status);
    });
  };
  return (
    <div className="building-inline-form" aria-label="DXF import">
      <FileField
        label="Import survey DXF"
        accept=".dxf"
        ariaLabel="Survey DXF file"
        onText={(text, fileName) => dispatch('import_survey_dxf', { text, name: fileStem(fileName), sourceUnit: unit })}
      />
      <FileField
        label="Import DXF drawing"
        accept=".dxf"
        ariaLabel="Drawing DXF file"
        onText={(text) => dispatch('import_dxf', { text, sourceUnit: unit })}
      />
      <FileField
        label="Import DWG drawing (via server)"
        accept=".dwg"
        ariaLabel="Drawing DWG file"
        onFile={(file) => importDwg(file, 'drawing')}
      />
      <FileField
        label="Import survey DWG (via server)"
        accept=".dwg"
        ariaLabel="Survey DWG file"
        onFile={(file) => importDwg(file, 'survey')}
      />
      <StatusLine text={dwgStatus} />
    </div>
  );
}
