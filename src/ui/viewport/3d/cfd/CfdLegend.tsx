// Colour legend of the flow layers on the model (bottom-left of the viewport): the field, its unit and range for the slice, and the
// speed range of the streamlines. Same scale as the overlay paints (`resultColor`).

import React from 'react';
import '@ui/styles/panels/analysisOverlay.css';
import '@ui/styles/panels/flow.css';
import { resultColor } from '@lib/isoBands';
import { useFlowViewStore } from '@ui/store/flowViewStore';
import { formatQuantities } from '@ui/panels/analysis/quantityFormat';

const FIELD_TITLES: Readonly<Record<string, { title: string; unit: string }>> = {
  speed: { title: 'Speed', unit: 'm/s' },
  p: { title: 'Gauge pressure', unit: 'Pa' },
  cp: { title: 'Pressure coefficient', unit: '' },
  ux: { title: 'Velocity x', unit: 'm/s' },
  uy: { title: 'Velocity y', unit: 'm/s' },
  uz: { title: 'Velocity z', unit: 'm/s' },
};

const GRADIENT = `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map(resultColor).join(', ')})`;

function Ramp({ title, unit, range }: { title: string; unit: string; range: { min: number; max: number } | null }): React.ReactElement {
  if (range === null) return <p className="analysis-legend__sub">{title}: no values in the fluid on this plane.</p>;
  const shown = formatQuantities([range.min, range.max], unit);
  return (
    <>
      <h4 className="analysis-legend__title">
        {title} {shown.unit !== '' && <span className="analysis-legend__unit">[{shown.unit}]</span>}
      </h4>
      <div className="flow-legend__bar" style={{ background: GRADIENT }} role="img" aria-label={`${title} colour scale`} />
      <div className="flow-legend__ends">
        <span data-testid="cfd-legend-min">{shown.texts[0]}</span>
        <span data-testid="cfd-legend-max">{shown.texts[1]}</span>
      </div>
    </>
  );
}

export function CfdLegend(): React.ReactElement | null {
  const caseId = useFlowViewStore((s) => s.caseId);
  const showSlice = useFlowViewStore((s) => s.showSlice);
  const showStreamlines = useFlowViewStore((s) => s.showStreamlines);
  const slice = useFlowViewStore((s) => s.slice);
  const streamlines = useFlowViewStore((s) => s.streamlines);
  const sliceReady = caseId !== null && showSlice && slice.status === 'ready' ? slice.value : null;
  const linesReady = caseId !== null && showStreamlines && streamlines.status === 'ready' ? streamlines.value : null;
  if (sliceReady === null && linesReady === null) return null;
  const field = sliceReady === null ? undefined : (FIELD_TITLES[sliceReady.file.field] ?? { title: sliceReady.file.field, unit: '' });
  return (
    <aside className="analysis-legend" data-testid="cfd-legend" aria-label="Flow colour legend">
      {sliceReady !== null && field !== undefined && (
        <Ramp title={`Slice: ${field.title}`} unit={field.unit} range={sliceReady.file.range} />
      )}
      {linesReady !== null && <Ramp title="Streamlines: speed" unit="m/s" range={linesReady.file.range} />}
    </aside>
  );
}
