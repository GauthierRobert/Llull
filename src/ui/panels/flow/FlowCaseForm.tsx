// Set-up of a new flow case: gathers the body (the selected solids), the free stream and the reference quantities, then dispatches
// `create_cfd_case`. Everything else (regime, domain, boundaries) keeps the command's named defaults; `update_cfd_case` edits them later.

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { PanelSection } from '@ui/panels/PanelParts';

interface FlowCaseFormProps {
  /** Id suggested for the new case. */
  suggestedId: string;
  onCreated(caseId: string): void;
}

const positive = (text: string): number | null => {
  const value = Number(text);
  return text.trim() !== '' && Number.isFinite(value) && value > 0 ? value : null;
};

const finiteOrZero = (text: string): number | null => {
  const value = Number(text);
  return text.trim() === '' ? 0 : Number.isFinite(value) ? value : null;
};

export function FlowCaseForm({ suggestedId, onCreated }: FlowCaseFormProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const selection = useStore((s) => s.document.selection);
  const [id, setId] = useState('');
  const [speed, setSpeed] = useState('30');
  const [altitude, setAltitude] = useState('0');
  const [alpha, setAlpha] = useState('0');
  const [area, setArea] = useState('');
  const [length, setLength] = useState('');
  const [cells, setCells] = useState('');
  const caseId = id.trim() === '' ? suggestedId : id.trim();
  const numbers = {
    speedMS: positive(speed),
    altitudeM: finiteOrZero(altitude),
    alphaDeg: finiteOrZero(alpha),
    areaM2: positive(area),
    lengthM: positive(length),
    cells: cells.trim() === '' ? undefined : positive(cells),
  };
  const problem =
    selection.length === 0
      ? 'Select the solids to put in the flow (Objects list or the model).'
      : numbers.speedMS === null
        ? 'Free-stream speed must be a positive number.'
        : numbers.areaM2 === null || numbers.lengthM === null
          ? 'Reference area and length must be positive numbers.'
          : numbers.altitudeM === null || numbers.alphaDeg === null
            ? 'Altitude and angle of attack must be numbers.'
            : numbers.cells === null
              ? 'Cells per reference length must be a positive whole number or empty.'
              : '';

  const create = (): void => {
    if (problem !== '' || numbers.speedMS === null || numbers.areaM2 === null || numbers.lengthM === null) return;
    dispatch('create_cfd_case', {
      id: caseId,
      entityIds: selection,
      freestream: { speedMS: numbers.speedMS, altitudeM: numbers.altitudeM ?? 0, alphaDeg: numbers.alphaDeg ?? 0 },
      reference: { areaM2: numbers.areaM2, lengthM: numbers.lengthM },
      ...(numbers.cells === undefined || numbers.cells === null ? {} : { cellsPerReferenceLength: Math.round(numbers.cells) }),
    });
    onCreated(caseId);
  };

  return (
    <PanelSection
      title="New case"
      collapsible
      defaultOpen={false}
      hint={`${selection.length} selected solid${selection.length === 1 ? '' : 's'} go into the flow. Lengths are metres.`}
      testId="flow-new-case"
    >
      <div className="flow__inputs">
        <LabeledInput label="Case id" type="text" value={id} placeholder={suggestedId} onChange={setId} testId="flow-case-id" />
        <LabeledInput label="Speed (m/s)" type="number" value={speed} onChange={setSpeed} testId="flow-speed" />
        <LabeledInput label="Altitude (m)" type="number" value={altitude} onChange={setAltitude} testId="flow-altitude" />
        <LabeledInput label="Angle of attack (°)" type="number" value={alpha} onChange={setAlpha} testId="flow-alpha" />
        <LabeledInput label="Reference area (m²)" type="number" value={area} onChange={setArea} testId="flow-area" />
        <LabeledInput label="Reference length (m)" type="number" value={length} onChange={setLength} testId="flow-length" />
        <LabeledInput
          label="Cells per length"
          type="number"
          value={cells}
          placeholder="standard (128)"
          onChange={setCells}
          testId="flow-cells"
        />
      </div>
      <button type="button" className="btn btn--primary btn--sm" disabled={problem !== ''} onClick={create} data-testid="flow-create">
        Create case
      </button>
      {problem !== '' && (
        <p className="analysis__hint" data-testid="flow-create-problem">
          {problem}
        </p>
      )}
    </PanelSection>
  );
}
