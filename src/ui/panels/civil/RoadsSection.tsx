/**
 * @layer ui/panels/civil
 *
 * RoadsSection — `add_alignment` (PIs typed or taken from the selected polyline, curve radii,
 * clothoid spiral lengths, ground surface) and one AlignmentEditor per alignment.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { PanelSection } from '@ui/panels/PanelParts';
import { chosenId, CivilObjectSelect, useCivilObjects } from './CivilParts';
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
          <input
            value={points}
            placeholder="x,y; x,y; x,y; …"
            aria-label="Alignment points"
            onChange={(event) => setPoints(event.target.value)}
          />
          <button type="button" className="btn btn--ghost btn--sm" onClick={takeSelection}>
            From selection
          </button>
        </div>
        <div className="building-inline-form">
          <input
            value={radii}
            placeholder="Radii per interior PI"
            aria-label="Curve radii"
            onChange={(event) => setRadii(event.target.value)}
          />
          <input
            value={spirals}
            placeholder="Spiral lengths (clothoid)"
            aria-label="Spiral lengths"
            onChange={(event) => setSpirals(event.target.value)}
          />
          <CivilObjectSelect
            objects={surfaces}
            value={surfaceId}
            label="Alignment surface"
            emptyLabel="No ground surface"
            onChange={setSurface}
          />
          <input
            type="number"
            value={interval}
            placeholder="Station interval"
            aria-label="Station interval"
            onChange={(event) => setIntervalText(event.target.value)}
          />
          <input
            value={name}
            placeholder="Name"
            aria-label="Alignment name"
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="btn btn--primary btn--sm">
            Add alignment
          </button>
        </div>
        {error !== '' && (
          <p className="panel__error" role="alert">
            {error}
          </p>
        )}
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
