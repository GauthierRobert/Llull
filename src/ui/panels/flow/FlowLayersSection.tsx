// What to draw on the model: the slice plane and the streamline rake. Gathers the choice, runs the read-only query transports through
// `useFlowLayers`, and toggles the layers of the overlay.

import React, { useState } from 'react';
import { useFlowViewStore } from '@ui/store/flowViewStore';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { OptionSelect } from '@ui/panels/OptionSelect';
import { PanelSection, StatusLine } from '@ui/panels/PanelParts';
import type { FlowCase } from './flowData';
import { defaultSlicePosition, SLICE_AXES, SLICE_FIELDS, type SliceAxis, type SliceField } from './flowQueries';
import { useFlowLayers } from './useFlowLayers';

const FIELD_TEXT: Readonly<Record<SliceField, string>> = {
  speed: 'Speed (m/s)',
  p: 'Pressure (Pa)',
  cp: 'Pressure coefficient',
  ux: 'Velocity x (m/s)',
  uy: 'Velocity y (m/s)',
  uz: 'Velocity z (m/s)',
};
const SEED_COUNTS = ['6', '8', '12', '16'] as const;

interface FlowLayersSectionProps {
  cfdCase: FlowCase;
  /** Why no query can run (no result, or a stale one); null when it can. */
  blocked: string | null;
}

export function FlowLayersSection({ cfdCase, blocked }: FlowLayersSectionProps): React.ReactElement {
  const layers = useFlowLayers(cfdCase);
  const showSlice = useFlowViewStore((s) => s.showSlice);
  const showStreamlines = useFlowViewStore((s) => s.showStreamlines);
  const sliceFeed = useFlowViewStore((s) => s.slice);
  const streamFeed = useFlowViewStore((s) => s.streamlines);
  const [axis, setAxis] = useState<SliceAxis>('y');
  const [field, setField] = useState<SliceField>('speed');
  const [position, setPosition] = useState('');
  const [seeds, setSeeds] = useState<(typeof SEED_COUNTS)[number]>('8');
  const positionM = position.trim() === '' || !Number.isFinite(Number(position)) ? null : Number(position);
  const reason = blocked ?? (layers.online ? null : 'Needs the llull backend (desktop app or `llull serve`).');
  return (
    <PanelSection title="On the model" hint="Colour map on a plane and streamlines from a rake upstream of the body." testId="flow-layers">
      <label className="loads-check">
        <input
          type="checkbox"
          checked={showSlice}
          onChange={(e) => useFlowViewStore.getState().setShowSlice(e.target.checked)}
          data-testid="flow-show-slice"
        />
        Show slice
      </label>
      <label className="field">
        <span className="field__label">Plane normal</span>
        <OptionSelect
          value={axis}
          options={SLICE_AXES}
          label="Slice plane normal"
          optionLabel={(a) => a.toUpperCase()}
          testId="flow-slice-axis"
          onChange={setAxis}
        />
      </label>
      <LabeledInput
        label="Position (m)"
        type="number"
        value={position}
        placeholder={String(defaultSlicePosition(cfdCase, axis))}
        onChange={setPosition}
        testId="flow-slice-position"
      />
      <label className="field">
        <span className="field__label">Field</span>
        <OptionSelect
          value={field}
          options={SLICE_FIELDS}
          label="Slice field"
          optionLabel={(f) => FIELD_TEXT[f]}
          testId="flow-slice-field"
          onChange={setField}
        />
      </label>
      <button
        type="button"
        className="btn btn--sm"
        data-testid="flow-slice-run"
        disabled={reason !== null || sliceFeed.status === 'loading'}
        onClick={() => layers.showSlice({ axis, field, positionM })}
      >
        {sliceFeed.status === 'loading' ? 'Sampling…' : 'Sample slice'}
      </button>
      {sliceFeed.status === 'refused' && <StatusLine text={sliceFeed.reason} testId="flow-slice-refused" />}

      <label className="loads-check">
        <input
          type="checkbox"
          checked={showStreamlines}
          onChange={(e) => useFlowViewStore.getState().setShowStreamlines(e.target.checked)}
          data-testid="flow-show-streamlines"
        />
        Show streamlines
      </label>
      <label className="field">
        <span className="field__label">Seeds per side</span>
        <OptionSelect value={seeds} options={SEED_COUNTS} label="Seeds per side" testId="flow-seeds" onChange={setSeeds} />
      </label>
      <button
        type="button"
        className="btn btn--sm"
        data-testid="flow-streamlines-run"
        disabled={reason !== null || streamFeed.status === 'loading'}
        onClick={() => layers.traceStreamlines(Number(seeds))}
      >
        {streamFeed.status === 'loading' ? 'Tracing…' : 'Trace streamlines'}
      </button>
      {streamFeed.status === 'ready' && <StatusLine text={streamFeed.value.summary} testId="flow-streamlines-summary" />}
      {streamFeed.status === 'refused' && <StatusLine text={streamFeed.reason} testId="flow-streamlines-refused" />}
      {reason !== null && (
        <p className="analysis__hint" data-testid="flow-layers-reason">
          {reason}
        </p>
      )}
    </PanelSection>
  );
}
