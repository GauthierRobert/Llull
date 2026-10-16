// `create_surface` (TIN + contours) from point groups; per surface its `surface_report` and contour interval (`update_surface`).

import React from 'react';
import type { SurfaceObject } from '@core/model/civil';
import { useStore } from '@ui/store';
import { PanelSection } from '@ui/panels/PanelParts';
import { useCivilObjects, NumberTextField, TextField, type CivilStepState } from './CivilParts';
import { CivilReportRow } from './CivilReportRow';
import { useFormValues } from '@ui/panels/useFormValues';

const SURFACE_FORM = { name: '', interval: '', majorEvery: '', maxEdge: '' };
import { optionalNumber, parseNumber, optionalText } from '@ui/numberText';

function SurfaceRow({ surface }: { surface: SurfaceObject }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  return (
    <CivilReportRow
      object={surface}
      report={{ command: 'surface_report', idKey: 'surfaceId' }}
      field={{ hint: String(surface.contourInterval), label: `Contour interval of ${surface.name}` }}
      action={{
        label: 'Set interval',
        run: (text) => {
          const value = parseNumber(text);
          if (value === undefined || value <= 0) return false;
          dispatch('update_surface', { surfaceId: surface.id, contourInterval: value });
          return true;
        },
      }}
    />
  );
}

export function TerrainSection({ defaultOpen = true, done = false }: Partial<CivilStepState>): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const units = useStore((s) => s.document.units);
  const groups = useCivilObjects('pointGroup');
  const surfaces = useCivilObjects('surface');
  const { values, field, change } = useFormValues(() => SURFACE_FORM);

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    dispatch('create_surface', {
      ...optionalText('name', values.name),
      ...optionalNumber('contourInterval', values.interval),
      ...optionalNumber('majorEvery', values.majorEvery),
      ...optionalNumber('maxEdgeLength', values.maxEdge),
    });
    change('name', '');
  };

  return (
    <PanelSection
      title="Terrain"
      step={2}
      hint={`Existing-ground TIN surface with contours (lengths in ${units}).`}
      count={surfaces.length}
      countLabel={`${surfaces.length} surfaces`}
      collapsible
      defaultOpen={defaultOpen}
      done={done}
      testId="civil-terrain"
    >
      {surfaces.length > 0 && (
        <ul className="civil-list" aria-label="Surfaces">
          {surfaces.map((surface) => (
            <SurfaceRow key={surface.id} surface={surface} />
          ))}
        </ul>
      )}
      <form className="building-inline-form" onSubmit={handleSubmit} aria-label="Create surface">
        <TextField {...field('name')} hint="e.g. Existing ground" label="Surface name" />
        <NumberTextField {...field('interval')} hint="e.g. 0.5" label="Contour interval" />
        <NumberTextField {...field('majorEvery')} hint="e.g. 5" label="Major contour every" />
        <NumberTextField {...field('maxEdge')} hint="optional" label="Maximum triangle edge" />
        <button type="submit" className="btn btn--primary btn--sm" disabled={groups.length === 0}>
          Create surface
        </button>
      </form>
    </PanelSection>
  );
}
