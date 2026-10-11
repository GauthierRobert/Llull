/**
 * @layer ui/panels/civil
 *
 * RoadsSection — `add_alignment` (PIs typed or taken from the selected polyline, curve radii,
 * clothoid spiral lengths, ground surface) and one AlignmentEditor per alignment.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { PanelSection, FormError } from '@ui/panels/PanelParts';
import { chosenId, CivilObjectSelect, useCivilObjects, NumberField, TextField } from './CivilParts';
import {
  formatPoints,
  optionalNumber,
  parseNumberList,
  parsePoints,
  selectedPolylinePoints,
} from './civilInput';
import { AlignmentEditor } from './AlignmentEditor';

export function RoadsSection(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const surfaces = useCivilObjects('surface');
  const alignments = useCivilObjects('alignment');
  const [points, setPoints] = useState('');
  const [radii, setRadii] = useState('');
  const [spirals, setSpirals] = useState('');
  const [surface, setSurface] = useState('');
  const [interval, setIntervalText] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const surfaceId = chosenId(surfaces, surface, true);

  const takeSelection = (): void => {
    const selected = selectedPolylinePoints(useStore.getState().document);
    if (selected === null) setError('Select one polyline first.');
    else {
      setPoints(formatPoints(selected));
      setError('');
    }
  };

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const parsed = parsePoints(points);
    const radiusList = parseNumberList(radii);
    const spiralList = parseNumberList(spirals);
    if (parsed === null || parsed.length < 2) {
      setError('Points: at least 2 points "x,y; x,y".');
      return;
    }
    if (radiusList === null) {
      setError('Radii: numbers separated by commas, one per interior point.');
      return;
    }
    if (spiralList === null) {
      setError('Spirals: lengths separated by commas, one per interior point (0 = none).');
      return;
    }
    dispatch('add_alignment', {
      points: parsed,
      ...(radiusList.length > 0 ? { radii: radiusList } : {}),
      ...(spiralList.length > 0 ? { spirals: spiralList } : {}),
      ...(surfaceId !== '' ? { surfaceId } : {}),
      ...optionalNumber('stationInterval', interval),
      ...(name.trim() !== '' ? { name: name.trim() } : {}),
    });
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
        <div className="building-inline-form">
          <TextField
            value={points}
            set={setPoints}
            hint="x,y; x,y; x,y; …"
            label="Alignment points"
          />
          <button type="button" className="btn btn--ghost btn--sm" onClick={takeSelection}>
            From selection
          </button>
        </div>
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
