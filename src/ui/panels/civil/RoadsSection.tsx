// `add_alignment` (PIs typed or from the selected polyline, radii, spirals, ground) + one AlignmentEditor each.

import React from 'react';
import { useStore } from '@ui/store';
import { PanelSection, FormError } from '@ui/panels/PanelParts';
import { CivilObjectSelect, useCivilObjects, NumberTextField, PointsFromSelectionRow, TextField, useChosenId } from './CivilParts';
import { alignmentParamsOf } from './civilRules';
import { AlignmentEditor } from './AlignmentEditor';
import { useFormValues } from '@ui/panels/useFormValues';

const ALIGNMENT_FORM = { points: '', radii: '', spirals: '', interval: '', name: '' };

export function RoadsSection(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const surfaces = useCivilObjects('surface');
  const alignments = useCivilObjects('alignment');
  const [surfaceId, setSurface] = useChosenId(surfaces, true);
  const { values, error, setError, field } = useFormValues(() => ALIGNMENT_FORM);

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const gathered = alignmentParamsOf({ ...values, surfaceId });
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
          {...field('points')}
          label="Alignment points"
          noSelectionError="Select one polyline first."
          setError={setError}
        />
        <div className="building-inline-form">
          <TextField {...field('radii')} hint="Radii per interior PI" label="Curve radii" />
          <TextField {...field('spirals')} hint="Spiral lengths (clothoid)" label="Spiral lengths" />
          <CivilObjectSelect
            objects={surfaces}
            value={surfaceId}
            label="Alignment surface"
            emptyLabel="No ground surface"
            onChange={setSurface}
          />
          <NumberTextField {...field('interval')} hint="Station interval" label="Station interval" />
          <TextField {...field('name')} hint="Name" label="Alignment name" />
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
