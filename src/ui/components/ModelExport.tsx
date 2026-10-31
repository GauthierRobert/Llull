// Download the model as a mesh (STL, read-only `export_stl`), as code (CadQuery, build123d, OpenSCAD, FreeCAD; read-only `export_code`) or exact STEP from the
// server's `/export/step` (Python bridge).

import React, { useState } from 'react';
import { runQuery } from '@ui/services/localQuery';
import { downloadBlob as download, downloadText } from '@ui/download';
import { isCodeExportData, isStlExportData } from '@ui/resultData';
import { type ExactExportCommand, fetchExactExport, fetchStepExport } from '@ui/services/serverFiles';
import { desktopBridge } from '@ui/desktopBridge';

type ExportFormat = '3mf' | 'stl' | 'cadquery' | 'build123d' | 'openscad' | 'freecad' | 'step' | 'ap242' | 'iges';

const FORMATS: ReadonlyArray<{ value: ExportFormat; label: string }> = [
  { value: '3mf', label: '3MF package (.3mf)' },
  { value: 'stl', label: 'STL mesh (.stl)' },
  { value: 'cadquery', label: 'CadQuery (.py)' },
  { value: 'build123d', label: 'build123d (.py)' },
  { value: 'openscad', label: 'OpenSCAD (.scad)' },
  { value: 'freecad', label: 'FreeCAD macro' },
  { value: 'step', label: 'STEP (.step)' },
  { value: 'ap242', label: 'STEP AP242 + validation properties (.stp)' },
  { value: 'iges', label: 'IGES 5.3 (.igs)' },
];

const EXACT: Readonly<Record<'ap242' | 'iges', ExactExportCommand>> = {
  ap242: { command: 'export_step_ap242', field: 'step', fileName: 'model.stp' },
  iges: { command: 'export_iges', field: 'iges', fileName: 'model.igs' },
};

export function ModelExport(): React.ReactElement {
  const [format, setFormat] = useState<ExportFormat>('stl');
  const [status, setStatus] = useState('');

  const exportCode = (language: Exclude<ExportFormat, 'step' | 'stl' | 'ap242' | 'iges' | '3mf'>): void => {
    const result = runQuery('export_code', { language, name: 'model' });
    if (!isCodeExportData(result.data)) {
      setStatus(result.summary);
      return;
    }
    const { text, fileName } = result.data;
    downloadText(text, fileName, 'text/plain');
    setStatus(result.summary);
  };

  const exportThreeMf = async (): Promise<void> => {
    const bridge = desktopBridge();
    if (bridge === null) {
      setStatus('3MF export needs the desktop app');
      return;
    }
    setStatus('Exporting 3MF…');
    const outcome = await bridge.exportThreeMf();
    setStatus(outcome.message);
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

  const exportExact = async (kind: 'ap242' | 'iges'): Promise<void> => {
    setStatus('Exporting…');
    const spec = EXACT[kind];
    const result = await fetchExactExport(spec, new Date().toISOString().slice(0, 19));
    if (result.ok) download(result.blob, spec.fileName);
    setStatus(result.message);
  };

  const handleExport = (): void => {
    if (format === '3mf') void exportThreeMf();
    else if (format === 'ap242' || format === 'iges') void exportExact(format);
    else if (format === 'step') void exportStep();
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
        title="Export the 3D model as script code, STEP (AP242 with validation properties) or IGES. Building drawings, DXF and IFC are in the Building panel › Deliverables."
      >
        {FORMATS.filter((f) => f.value !== '3mf' || desktopBridge() !== null).map((f) => (
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
