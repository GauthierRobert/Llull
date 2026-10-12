/**
 * @layer ui/panels/civil
 *
 * RoadsSection — `add_alignment` (PIs typed or taken from the selected polyline, curve radii,
 * clothoid spiral lengths, ground surface) and one AlignmentEditor per alignment.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { PanelSection, FormError } from '@ui/panels/PanelParts';
import {
  CivilObjectSelect,
  useCivilObjects,
  NumberField,
  PointsFromSelectionRow,
  TextField,
  useChosenId,
} from './CivilParts';
import { alignmentParamsOf } from './civilRules';
import { AlignmentEditor } from './AlignmentEditor';

export function RoadsSection(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const surfaces = useCivilObjects('surface');
  const alignments = useCivilObjects('alignment');
  const [points, setPoints] = useState('');
  const [radii, setRadii] = useState('');
  const [spirals, setSpirals] = useState('');
  const [surfaceId, setSurface] = useChosenId(surfaces, true);
  const [interval, setIntervalText] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const gathered = alignmentParamsOf({ points, radii, spirals, surfaceId, interval, name });
    if (!gathered.ok) {
      setError(gathered.error);
      return;
    }
    dispatch('add_alignment', gathered.params);
    setError('');
  };

  return (
    <PanelSection
      title="Roads"
      step={4}
      hint="Centreline with curves, design profile, road template, long and cross sections."
      count={alignments.length}
      countLabel={`${alignments.length} alignments`}
      collapsible
      testId="civil-roads"
    >
      <form className="civil-form" onSubmit={handleSubmit} aria-label="Add alignment">
        <PointsFromSelectionRow
          value={points}
          set={setPoints}
          label="Alignment points"
          noSelectionError="Select one polyline first."
          setError={setError}
        />
        <div className="building-inline-form">
          <TextField
            value={radii}
            set={setRadii}
            hint="Radii per interior PI"
            label="Curve radii"
          />
          <TextField
            value={spirals}
            set={setSpirals}
            hint="Spiral lengths (clothoid)"
            label="Spiral lengths"
          />
          <CivilObjectSelect
            objects={surfaces}
            value={surfaceId}
            label="Alignment surface"
            emptyLabel="No ground surface"
            onChange={setSurface}
          />
          <NumberField
            value={interval}
            set={setIntervalText}
            hint="Station interval"
            label="Station interval"
          />
          <TextField value={name} set={setName} hint="Name" label="Alignment name" />
          <button type="submit" className="btn btn--primary btn--sm">
            Add alignment
          </button>
        </div>
        <FormError text={error} />
      </form>
      {alignments.length > 0 && (
        <ul className="civil-list" aria-label="Alignments">
          {alignments.map((alignment) => (
            <AlignmentEditor key={alignment.id} alignment={alignment} />
          ))}
        </ul>
      )}
    </PanelSection>
  );
}
