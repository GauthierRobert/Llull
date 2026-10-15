// Download the model as a mesh (STL, read-only `export_stl`), as code (CadQuery, build123d, OpenSCAD, FreeCAD; read-only `export_code`) or exact STEP from the
// server's `/export/step` (Python bridge).

import React, { useState } from 'react';
import { runQuery } from '@ui/services/localQuery';
import { downloadBlob as download, downloadText } from '@ui/download';
import { isCodeExportData, isStlExportData } from '@ui/resultData';
import { fetchStepExport } from '@ui/services/serverFiles';

type ExportFormat = 'stl' | 'cadquery' | 'build123d' | 'openscad' | 'freecad' | 'step';

const FORMATS: ReadonlyArray<{ value: ExportFormat; label: string }> = [
  { value: 'stl', label: 'STL mesh (.stl)' },
  { value: 'cadquery', label: 'CadQuery (.py)' },
  { value: 'build123d', label: 'build123d (.py)' },
  { value: 'openscad', label: 'OpenSCAD (.scad)' },
  { value: 'freecad', label: 'FreeCAD macro' },
  { value: 'step', label: 'STEP (.step)' },
];

export function ModelExport(): React.ReactElement {
  const [format, setFormat] = useState<ExportFormat>('stl');
  const [status, setStatus] = useState('');

  const exportCode = (language: Exclude<ExportFormat, 'step' | 'stl'>): void => {
    const result = runQuery('export_code', { language, name: 'model' });
    if (!isCodeExportData(result.data)) {
      setStatus(result.summary);
      return;
    }
    const { text, fileName } = result.data;
    downloadText(text, fileName, 'text/plain');
    setStatus(result.summary);
  };

  const exportStl = (): void => {
    const result = runQuery('export_stl', { format: 'binary', name: 'model' });
    if (isStlExportData(result.data)) {
      const bytes = Uint8Array.from(atob(result.data.stlBase64), (char) => char.charCodeAt(0));
      download(new Blob([bytes], { type: 'model/stl' }), 'model.stl');
    }
    setStatus(result.summary);
  };

  const exportStep = async (): Promise<void> => {
    setStatus('Exporting STEP…');
    const result = await fetchStepExport('model');
    if (result.ok) download(result.blob, 'model.step');
    setStatus(result.message);
  };

  const handleExport = (): void => {
    if (format === 'step') void exportStep();
    else if (format === 'stl') exportStl();
    else exportCode(format);
  };

  return (
    <span className="project-io" role="group" aria-label="Export model">
      <select
        className="project-io__select"
        value={format}
        onChange={(e) => setFormat(e.target.value as ExportFormat)}
        aria-label="Export format"
        title="Export the 3D model as script code or STEP. Building drawings, DXF and IFC are in the Building panel › Deliverables."
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
        title="Export model (STEP is generated from the server’s live model)"
      >
        Export
      </button>
      <span className="project-io__status" role="status" aria-live="polite">
        {status}
      </span>
    </span>
  );
}
