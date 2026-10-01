/**
 * @layer ui/components
 *
 * ModelExport — download the model as parametric code (CadQuery, build123d, OpenSCAD, FreeCAD
 * macro) via the read-only `export_code` command, or as an exact STEP file from the server's
 * `/export/step` route (Python bridge). Presentation + download only; no document mutation.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { execute } from '@core/commands/registry';
import { SERVER_BASE, serverAuthHeaders } from '@ui/serverConfig';

type ExportFormat = 'cadquery' | 'build123d' | 'openscad' | 'freecad' | 'step';

const FORMATS: ReadonlyArray<{ value: ExportFormat; label: string }> = [
  { value: 'cadquery', label: 'CadQuery (.py)' },
  { value: 'build123d', label: 'build123d (.py)' },
  { value: 'openscad', label: 'OpenSCAD (.scad)' },
  { value: 'freecad', label: 'FreeCAD macro' },
  { value: 'step', label: 'STEP (.step)' },
];

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ModelExport(): React.ReactElement {
  const document = useStore((s) => s.document);
  const [format, setFormat] = useState<ExportFormat>('cadquery');
  const [status, setStatus] = useState('');

  const exportCode = (language: Exclude<ExportFormat, 'step'>): void => {
    const result = execute(document, 'export_code', { language, name: 'model' });
    const data = result.data as { text?: string; fileName?: string } | undefined;
    if (data?.text === undefined || data.fileName === undefined) {
      setStatus(result.summary);
      return;
    }
    download(new Blob([data.text], { type: 'text/plain;charset=utf-8' }), data.fileName);
    setStatus(result.summary);
  };

  const exportStep = async (): Promise<void> => {
    setStatus('Exporting STEP…');
    try {
      const response = await fetch(`${SERVER_BASE}/export/step?name=model`, {
        headers: serverAuthHeaders(),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setStatus(body.error ?? `STEP export failed (HTTP ${response.status}).`);
        return;
      }
      download(await response.blob(), 'model.step');
      setStatus('STEP exported from the server model.');
    } catch {
      setStatus(`STEP export needs the llull server at ${SERVER_BASE}.`);
    }
  };

  const handleExport = (): void => {
    if (format === 'step') void exportStep();
    else exportCode(format);
  };

  return (
    <span className="project-io" role="group" aria-label="Export model">
      <select
        className="project-io__select"
        value={format}
        onChange={(e) => setFormat(e.target.value as ExportFormat)}
        aria-label="Export format"
      >
        {FORMATS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="project-io__btn"
        onClick={handleExport}
        aria-label="Export the model in the selected format"
        title={status !== '' ? status : 'Export model'}
      >
        Export
      </button>
    </span>
  );
}
