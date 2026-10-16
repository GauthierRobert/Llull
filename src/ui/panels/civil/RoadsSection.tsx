// `add_alignment` (PIs typed or from the selected polyline, radii, spirals, ground) + one AlignmentEditor each.

import React from 'react';
import { useStore } from '@ui/store';
import { PanelSection, FormError } from '@ui/panels/PanelParts';
import {
  CivilObjectSelect,
  useCivilObjects,
  NumberTextField,
  PointsFromSelectionRow,
  TextField,
  useChosenId,
  type CivilStepState,
} from './CivilParts';
import { alignmentParamsOf } from './civilRules';
import { AlignmentEditor } from './AlignmentEditor';
import { useFormValues } from '@ui/panels/useFormValues';

const ALIGNMENT_FORM = { points: '', radii: '', spirals: '', interval: '', name: '' };

export function RoadsSection({ defaultOpen = true, done = false }: Partial<CivilStepState>): React.ReactElement {
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
      defaultOpen={defaultOpen}
      done={done}
      testId="civil-roads"
    >
      {alignments.length > 0 && (
        <ul className="civil-list" aria-label="Alignments">
          {alignments.map((alignment) => (
            <AlignmentEditor key={alignment.id} alignment={alignment} />
          ))}
        </ul>
      )}
      <form className="civil-form" onSubmit={handleSubmit} aria-label="Add alignment">
        <PointsFromSelectionRow
          {...field('points')}
          label="Alignment points"
          noSelectionError="Select one polyline first."
          setError={setError}
        />
        <div className="building-inline-form">
          <TextField {...field('radii')} hint="one per interior PI" label="Curve radii" />
          <TextField {...field('spirals')} hint="clothoid, 0 = none" label="Spiral lengths" />
          <CivilObjectSelect
            objects={surfaces}
            value={surfaceId}
            label="Alignment surface"
            emptyLabel="No ground surface"
            onChange={setSurface}
          />
          <NumberTextField {...field('interval')} hint="e.g. 20" label="Station interval" />
          <TextField {...field('name')} hint="optional" label="Alignment name" />
          <button type="submit" className="btn btn--primary btn--sm">
            Add alignment
          </button>
        </div>
        <FormError text={error} />
      </form>
    </PanelSection>
  );
}
