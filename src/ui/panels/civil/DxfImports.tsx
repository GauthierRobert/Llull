// DXF inputs: survey points (`import_survey_dxf`: POINTs, blocks, 3D polylines) and a general `import_dxf`.

import React, { useState } from 'react';
import type { DocumentUnit } from '@core/model/types';
import type { DwgImportTarget } from '@protocol/restProtocol';
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
    <div className="civil-imports" role="group" aria-label="DXF import">
      <p className="civil-field__label civil-imports__title">Other survey and drawing files</p>
      <FileField
        label="Survey DXF"
        accept=".dxf"
        ariaLabel="Survey DXF file"
        title="Survey points from a DXF: POINTs, point blocks and 3D polyline vertices (import_survey_dxf)"
        onText={(text, fileName) => dispatch('import_survey_dxf', { text, name: fileStem(fileName), sourceUnit: unit })}
      />
      <FileField
        label="Survey DWG"
        accept=".dwg"
        ariaLabel="Survey DWG file"
        title="Survey points from a DWG, converted on the server"
        onFile={(file) => importDwg(file, 'survey')}
      />
      <FileField
        label="Drawing DXF"
        accept=".dxf"
        ariaLabel="Drawing DXF file"
        title="Linework of a DXF drawing as 2D entities (import_dxf)"
        onText={(text) => dispatch('import_dxf', { text, sourceUnit: unit })}
      />
      <FileField
        label="Drawing DWG"
        accept=".dwg"
        ariaLabel="Drawing DWG file"
        title="Linework of a DWG drawing, converted on the server"
        onFile={(file) => importDwg(file, 'drawing')}
      />
      <StatusLine text={dwgStatus} />
    </div>
  );
}
