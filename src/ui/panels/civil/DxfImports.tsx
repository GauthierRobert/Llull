/**
 * @layer ui/panels/civil
 *
 * DXF file inputs: survey points from a DXF (`import_survey_dxf`: POINTs, blocks, 3D polylines)
 * and a general drawing import (`import_dxf`). Reads the file as text, then dispatches.
 */

import React from 'react';
import type { DocumentUnit } from '@core/model/types';
import { useStore } from '@ui/store';

/** Reads the first chosen file as text (browser side effect, no document change). */
export function readChosenFile(
  event: React.ChangeEvent<HTMLInputElement>,
  onText: (text: string, fileName: string) => void,
): void {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === 'string') onText(reader.result, file.name);
  };
  reader.readAsText(file);
  event.target.value = '';
}

const stem = (fileName: string): string => fileName.replace(/\.[^.]+$/, '');

export function DxfImports({ unit }: { unit: DocumentUnit }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
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
              dispatch('import_survey_dxf', { text, name: stem(fileName), sourceUnit: unit }),
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
    </div>
  );
}
