/**
 * @layer ui/panels/civil
 *
 * DXF file inputs: survey points from a DXF (`import_survey_dxf`: POINTs, blocks, 3D polylines)
 * and a general drawing import (`import_dxf`). Reads the file as text, then dispatches.
 */

import React, { useState } from 'react';
import type { DocumentUnit } from '@core/model/types';
import type { DwgImportTarget } from '@mcp/restProtocol';
import { useStore } from '@ui/store';
import { fileStem, readChosenFile, takeChosenFile } from '@ui/chosenFile';
import { uploadDwg } from '@ui/services/serverFiles';

export function DxfImports({ unit }: { unit: DocumentUnit }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [dwgStatus, setDwgStatus] = useState('');
  const importDwg = (
    event: React.ChangeEvent<HTMLInputElement>,
    target: DwgImportTarget,
  ): void => {
    const file = takeChosenFile(event);
    if (!file) return;
    setDwgStatus(`Converting ${file.name}…`);
    void uploadDwg(file, target, unit).then(setDwgStatus);
  };
  return (
    <div className="building-inline-form" aria-label="DXF import">
      <label className="field">
        <span>Import survey DXF</span>
        <input
          type="file"
          accept=".dxf"
          aria-label="Survey DXF file"
          onChange={(event) =>
            readChosenFile(event, (text, fileName) =>
              dispatch('import_survey_dxf', { text, name: fileStem(fileName), sourceUnit: unit }),
            )
          }
        />
      </label>
      <label className="field">
        <span>Import DXF drawing</span>
        <input
          type="file"
          accept=".dxf"
          aria-label="Drawing DXF file"
          onChange={(event) =>
            readChosenFile(event, (text) => dispatch('import_dxf', { text, sourceUnit: unit }))
          }
        />
      </label>
      <label className="field">
        <span>Import DWG drawing (via server)</span>
        <input
          type="file"
          accept=".dwg"
          aria-label="Drawing DWG file"
          onChange={(event) => importDwg(event, 'drawing')}
        />
      </label>
      <label className="field">
        <span>Import survey DWG (via server)</span>
        <input
          type="file"
          accept=".dwg"
          aria-label="Survey DWG file"
          onChange={(event) => importDwg(event, 'survey')}
        />
      </label>
      {dwgStatus !== '' && (
        <p className="hint" role="status">
          {dwgStatus}
        </p>
      )}
    </div>
  );
}
