/**
 * @layer ui/panels/civil
 *
 * DXF file inputs: survey points from a DXF (`import_survey_dxf`: POINTs, blocks, 3D polylines)
 * and a general drawing import (`import_dxf`). Reads the file as text, then dispatches.
 */

import React, { useState } from 'react';
import type { DocumentUnit } from '@core/model/types';
import { useStore } from '@ui/store';
import { SERVER_BASE, serverAuthHeaders } from '@ui/serverConfig';

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

interface DwgImportReply {
  readonly summary?: string;
  readonly error?: string;
}

/** Uploads a DWG to the server, which converts it and runs the import command on the live document. */
async function uploadDwg(
  file: File,
  target: 'drawing' | 'survey',
  unit: DocumentUnit,
): Promise<string> {
  const query = new URLSearchParams({ target, sourceUnit: unit });
  if (target === 'survey') query.set('name', file.name.replace(/\.[^.]+$/, ''));
  try {
    const response = await fetch(`${SERVER_BASE}/import/dwg?${query.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...serverAuthHeaders() },
      body: file,
    });
    const reply = (await response.json().catch(() => ({}))) as DwgImportReply;
    if (!response.ok) return reply.error ?? `DWG import failed (HTTP ${response.status}).`;
    return reply.summary ?? 'DWG imported.';
  } catch {
    return `DWG import needs the llull server at ${SERVER_BASE} (offline), with a DWG converter installed.`;
  }
}

const stem = (fileName: string): string => fileName.replace(/\.[^.]+$/, '');

export function DxfImports({ unit }: { unit: DocumentUnit }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [dwgStatus, setDwgStatus] = useState('');
  const importDwg = (
    event: React.ChangeEvent<HTMLInputElement>,
    target: 'drawing' | 'survey',
  ): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
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
