// Inputs of the body analysis: which solids, flow direction, air speed, altitude and the drag coefficient.

import React from 'react';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import { FLOW_PRESETS, SPEED_UNIT_OPTIONS, type FlowPresetId } from './aeroData';
import type { AeroInputs } from './useAeroAnalysis';

const FLOW_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ...FLOW_PRESETS.map((preset) => [preset.id, `${preset.label} (air moves toward ${preset.label})`] as const),
  ['custom', 'Custom direction'],
];

const DRAG_MODE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['cd', 'Cd x frontal area'],
  ['cda', 'CdA (drag area)'],
];

interface AeroBodyInputsProps {
  inputs: AeroInputs;
  onChange: (next: AeroInputs) => void;
  solidCount: number;
}

export function AeroBodyInputs({ inputs, onChange, solidCount }: AeroBodyInputsProps): React.ReactElement {
  const set = (patch: Partial<AeroInputs>): void => onChange({ ...inputs, ...patch });
  return (
    <div className="aero__inputs">
      <label className="loads-check">
        <input
          type="checkbox"
          checked={inputs.allSolids}
          onChange={(event) => set({ allSolids: event.target.checked })}
          data-testid="aero-all-solids"
        />
        All solids ({solidCount}) instead of the selection
      </label>
      <LabeledSelect
        label="Flow"
        value={inputs.preset}
        options={FLOW_OPTIONS}
        testId="aero-flow"
        onChange={(value) => set({ preset: value as FlowPresetId })}
      />
      {inputs.preset === 'custom' && (
        <div className="aero__vector" role="group" aria-label="Custom flow direction">
          {(['x', 'y', 'z'] as const).map((axis, index) => (
            <LabeledInput
              key={axis}
              label={axis.toUpperCase()}
              type="number"
              value={inputs.custom[index] ?? '0'}
              ariaLabel={`Flow ${axis}`}
              className="aero__axis"
              onChange={(value) => {
                const custom: [string, string, string] = [inputs.custom[0], inputs.custom[1], inputs.custom[2]];
                custom[index] = value;
                set({ custom });
              }}
            />
          ))}
        </div>
      )}
      <div className="aero__pair">
        <LabeledInput
          label="Air speed"
          type="number"
          value={inputs.speed}
          testId="aero-speed"
          inputProps={{ min: 0 }}
          onChange={(speed) => set({ speed })}
        />
        <LabeledSelect label="Unit" value={inputs.speedUnit} options={SPEED_UNIT_OPTIONS} onChange={(speedUnit) => set({ speedUnit })} />
      </div>
      <LabeledInput
        label="Altitude (m)"
        type="number"
        value={inputs.altitude}
        testId="aero-altitude"
        title="Standard atmosphere altitude: sets air density and viscosity"
        onChange={(altitude) => set({ altitude })}
      />
      <LabeledSelect
        label="Drag from"
        value={inputs.dragMode}
        options={DRAG_MODE_OPTIONS}
        onChange={(value) => set({ dragMode: value === 'cda' ? 'cda' : 'cd' })}
      />
      {inputs.dragMode === 'cd' ? (
        <LabeledInput
          label="Cd"
          type="number"
          value={inputs.cd}
          testId="aero-cd"
          title="Drag coefficient from tests or references (car ~0.3, sphere ~0.47, flat plate 1.28)"
          inputProps={{ min: 0, step: 0.01 }}
          onChange={(cd) => set({ cd })}
        />
      ) : (
        <LabeledInput
          label="CdA (m²)"
          type="number"
          value={inputs.cdA}
          testId="aero-cda"
          inputProps={{ min: 0, step: 0.01 }}
          onChange={(cdA) => set({ cdA })}
        />
      )}
    </div>
  );
}
