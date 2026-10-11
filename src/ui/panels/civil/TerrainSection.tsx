/**
 * @layer ui/panels/civil
 *
 * TerrainSection — `create_surface` (TIN + contours) from the point groups, each surface with its
 * `surface_report` statistics and a contour-interval edit (`update_surface`).
 */

import React, { useMemo, useState } from 'react';
import type { SurfaceObject } from '@core/model/civil';
import { useStore } from '@ui/store';
import { PanelSection } from '@ui/panels/PanelParts';
import { CivilObjectRow, useCivilObjects, NumberField, TextField } from './CivilParts';
import { optionalNumber, parseNumber } from './civilInput';
import { runQuery } from './civilQuery';

function SurfaceRow({ surface }: { surface: SurfaceObject }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const civil = useStore((s) => s.document.civil);
  const units = useStore((s) => s.document.units);
  const [interval, setIntervalText] = useState('');
  const report = useMemo(
    () => runQuery('surface_report', { surfaceId: surface.id }).summary,
    // the report reads only the civil model and the document units
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [civil, units, surface.id],
  );
  const applyInterval = (): void => {
    const value = parseNumber(interval);
    if (value === undefined || value <= 0) return;
    dispatch('update_surface', { surfaceId: surface.id, contourInterval: value });
    setIntervalText('');
  };
  return (
    <CivilObjectRow object={surface} detail={report}>
      <NumberField
        value={interval}
        set={setIntervalText}
        hint={String(surface.contourInterval)}
        label={`Contour interval of ${surface.name}`}
      />
      <button type="button" className="btn btn--ghost btn--sm" onClick={applyInterval}>
        Set interval
      </button>
    </CivilObjectRow>
  );
}

export function TerrainSection(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const units = useStore((s) => s.document.units);
  const groups = useCivilObjects('pointGroup');
  const surfaces = useCivilObjects('surface');
  const [name, setName] = useState('');
  const [interval, setIntervalText] = useState('');
  const [majorEvery, setMajorEvery] = useState('');
  const [maxEdge, setMaxEdge] = useState('');

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    dispatch('create_surface', {
      ...(name.trim() !== '' ? { name: name.trim() } : {}),
      ...optionalNumber('contourInterval', interval),
      ...optionalNumber('majorEvery', majorEvery),
      ...optionalNumber('maxEdgeLength', maxEdge),
    });
    setName('');
  };

  return (
    <PanelSection
      title="Terrain"
      step={2}
      hint={`Existing-ground TIN surface with contours (lengths in ${units}).`}
      count={surfaces.length}
      countLabel={`${surfaces.length} surfaces`}
      collapsible
      testId="civil-terrain"
    >
      <form className="building-inline-form" onSubmit={handleSubmit} aria-label="Create surface">
        <TextField value={name} set={setName} hint="Surface name" label="Surface name" />
        <NumberField
          value={interval}
          set={setIntervalText}
          hint="Contour interval"
          label="Contour interval"
        />
        <NumberField
          value={majorEvery}
          set={setMajorEvery}
          hint="Major every"
          label="Major contour every"
        />
        <NumberField
          value={maxEdge}
          set={setMaxEdge}
          hint="Max edge (optional)"
          label="Maximum triangle edge"
        />
        <button type="submit" className="btn btn--primary btn--sm" disabled={groups.length === 0}>
          Create surface
        </button>
      </form>
      {surfaces.length > 0 && (
        <ul className="civil-list" aria-label="Surfaces">
          {surfaces.map((surface) => (
            <SurfaceRow key={surface.id} surface={surface} />
          ))}
        </ul>
      )}
    </PanelSection>
  );
}
