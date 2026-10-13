/**
 * EarthworksSection — `add_platform` (outline typed or taken from the selected polyline), each
 * platform's cut / fill (`platform_earthworks`) with a Balance button (`balance_platform`), and a
 * surface-to-surface volume comparison (`compare_surfaces`).
 */

import React, { useState } from 'react';
import type { PlatformObject } from '@core/model/civil';
import { useStore } from '@ui/store';
import { PanelSection, FormError, StatusLine } from '@ui/panels/PanelParts';
import { CivilObjectSelect, useCivilObjects, NumberTextField, PointsFromSelectionRow, TextField, useChosenId } from './CivilParts';
import { optionalNumber, parseNumber, optionalText } from '@ui/numberText';
import { parsePoints } from './civilInput';
import { useFormValues } from '@ui/panels/useFormValues';
import { runQuery } from '@ui/services/localQuery';
import { CivilReportRow } from './CivilReportRow';

const PLATFORM_FORM = { outline: '', elevation: '', cutSlope: '', fillSlope: '', name: '' };

function PlatformRow({ platform }: { platform: PlatformObject }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  return (
    <CivilReportRow
      object={platform}
      report={{ command: 'platform_earthworks', idKey: 'platformId' }}
      field={{ hint: 'Swell factor', label: `Swell factor of ${platform.name}` }}
      action={{
        label: 'Balance',
        title: 'Set the pad level so that cut and fill balance',
        run: (text) => {
          dispatch('balance_platform', {
            platformId: platform.id,
            ...optionalNumber('swellFactor', text),
          });
          return false;
        },
      }}
    />
  );
}

function CompareSurfaces(): React.ReactElement {
  const surfaces = useCivilObjects('surface');
  const [baseId, setBase] = useChosenId(surfaces);
  const [comparisonId, setComparison] = useChosenId(surfaces, false, 1);
  const [status, setStatus] = useState('');
  return (
    <div className="building-inline-form" aria-label="Compare surfaces">
      <CivilObjectSelect objects={surfaces} value={baseId} label="Base surface" onChange={setBase} />
      <CivilObjectSelect objects={surfaces} value={comparisonId} label="Comparison surface" onChange={setComparison} />
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        disabled={surfaces.length < 2}
        onClick={() =>
          setStatus(
            runQuery('compare_surfaces', {
              baseSurfaceId: baseId,
              comparisonSurfaceId: comparisonId,
            }).summary,
          )
        }
      >
        Compare volumes
      </button>
      <StatusLine text={status} testId="civil-compare-status" />
    </div>
  );
}

export function EarthworksSection(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const surfaces = useCivilObjects('surface');
  const platforms = useCivilObjects('platform');
  const [surfaceId, setSurface] = useChosenId(surfaces);
  const { values, error, setError, field } = useFormValues(() => PLATFORM_FORM);

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const boundary = parsePoints(values.outline);
    const level = parseNumber(values.elevation);
    if (boundary === null || boundary.length < 3) {
      setError('Outline: at least 3 points "x,y; x,y; x,y".');
      return;
    }
    if (level === undefined) {
      setError('Enter the pad elevation.');
      return;
    }
    dispatch('add_platform', {
      surfaceId,
      boundary,
      elevation: level,
      ...optionalNumber('cutSlope', values.cutSlope),
      ...optionalNumber('fillSlope', values.fillSlope),
      ...optionalText('name', values.name),
    });
    setError('');
  };

  return (
    <PanelSection
      title="Earthworks"
      step={3}
      hint="Building pads graded into the terrain: cut / fill volumes and balancing."
      count={platforms.length}
      countLabel={`${platforms.length} platforms`}
      collapsible
      testId="civil-earthworks"
    >
      <form className="civil-form" onSubmit={handleSubmit} aria-label="Add platform">
        <PointsFromSelectionRow
          {...field('outline')}
          label="Platform outline"
          noSelectionError="Select one closed polyline first."
          setError={setError}
        >
          <CivilObjectSelect objects={surfaces} value={surfaceId} label="Platform surface" onChange={setSurface} />
        </PointsFromSelectionRow>
        <div className="building-inline-form">
          <NumberTextField {...field('elevation')} hint="Pad elevation" label="Platform elevation" />
          <NumberTextField {...field('cutSlope')} hint="Cut H:1V (1.5)" label="Cut slope" />
          <NumberTextField {...field('fillSlope')} hint="Fill H:1V (2)" label="Fill slope" />
          <TextField {...field('name')} hint="Name" label="Platform name" />
          <button type="submit" className="btn btn--primary btn--sm" disabled={surfaceId === ''}>
            Add platform
          </button>
        </div>
        <FormError text={error} />
      </form>
      {platforms.length > 0 && (
        <ul className="civil-list" aria-label="Platforms">
          {platforms.map((platform) => (
            <PlatformRow key={platform.id} platform={platform} />
          ))}
        </ul>
      )}
      {surfaces.length > 1 && <CompareSurfaces />}
    </PanelSection>
  );
}
