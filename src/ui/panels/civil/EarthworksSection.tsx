/**
 * @layer ui/panels/civil
 *
 * EarthworksSection — `add_platform` (outline typed or taken from the selected polyline), each
 * platform's cut / fill (`platform_earthworks`) with a Balance button (`balance_platform`), and a
 * surface-to-surface volume comparison (`compare_surfaces`).
 */

import React, { useMemo, useState } from 'react';
import type { PlatformObject } from '@core/model/civil';
import { useStore } from '@ui/store';
import { PanelSection } from '@ui/panels/PanelParts';
import {
  chosenId,
  CivilObjectRow,
  CivilObjectSelect,
  CivilStatus,
  useCivilObjects,
} from './CivilParts';
import {
  formatPoints,
  optionalNumber,
  parseNumber,
  parsePoints,
  selectedPolylinePoints,
} from './civilInput';
import { runQuery } from './civilQuery';

function PlatformRow({ platform }: { platform: PlatformObject }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const civil = useStore((s) => s.document.civil);
  const units = useStore((s) => s.document.units);
  const [swell, setSwell] = useState('');
  const volumes = useMemo(
    () => runQuery('platform_earthworks', { platformId: platform.id }).summary,
    // the volumes read only the civil model and the document units
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [civil, units, platform.id],
  );
  return (
    <CivilObjectRow object={platform} detail={volumes}>
      <input
        type="number"
        value={swell}
        placeholder="Swell factor"
        aria-label={`Swell factor of ${platform.name}`}
        onChange={(event) => setSwell(event.target.value)}
      />
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        title="Set the pad level so that cut and fill balance"
        onClick={() =>
          dispatch('balance_platform', {
            platformId: platform.id,
            ...optionalNumber('swellFactor', swell),
          })
        }
      >
        Balance
      </button>
    </CivilObjectRow>
  );
}

function CompareSurfaces(): React.ReactElement {
  const surfaces = useCivilObjects('surface');
  const [base, setBase] = useState('');
  const [comparison, setComparison] = useState('');
  const [status, setStatus] = useState('');
  const baseId = chosenId(surfaces, base);
  const comparisonId = chosenId(surfaces, comparison !== '' ? comparison : (surfaces[1]?.id ?? ''));
  return (
    <div className="building-inline-form" aria-label="Compare surfaces">
      <CivilObjectSelect
        objects={surfaces}
        value={baseId}
        label="Base surface"
        onChange={setBase}
      />
      <CivilObjectSelect
        objects={surfaces}
        value={comparisonId}
        label="Comparison surface"
        onChange={setComparison}
      />
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
      <CivilStatus text={status} testId="civil-compare-status" />
    </div>
  );
}

export function EarthworksSection(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const surfaces = useCivilObjects('surface');
  const platforms = useCivilObjects('platform');
  const [surface, setSurface] = useState('');
  const [outline, setOutline] = useState('');
  const [elevation, setElevation] = useState('');
  const [cutSlope, setCutSlope] = useState('');
  const [fillSlope, setFillSlope] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const surfaceId = chosenId(surfaces, surface);

  const takeSelection = (): void => {
    const points = selectedPolylinePoints(useStore.getState().document);
    if (points === null) setError('Select one closed polyline first.');
    else {
      setOutline(formatPoints(points));
      setError('');
    }
  };

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const boundary = parsePoints(outline);
    const level = parseNumber(elevation);
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
      ...optionalNumber('cutSlope', cutSlope),
      ...optionalNumber('fillSlope', fillSlope),
      ...(name.trim() !== '' ? { name: name.trim() } : {}),
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
        <div className="building-inline-form">
          <CivilObjectSelect
            objects={surfaces}
            value={surfaceId}
            label="Platform surface"
            onChange={setSurface}
          />
          <input
            value={outline}
            placeholder="x,y; x,y; x,y; …"
            aria-label="Platform outline"
            onChange={(event) => setOutline(event.target.value)}
          />
          <button type="button" className="btn btn--ghost btn--sm" onClick={takeSelection}>
            From selection
          </button>
        </div>
        <div className="building-inline-form">
          <input
            type="number"
            value={elevation}
            placeholder="Pad elevation"
            aria-label="Platform elevation"
            onChange={(event) => setElevation(event.target.value)}
          />
          <input
            type="number"
            value={cutSlope}
            placeholder="Cut H:1V (1.5)"
            aria-label="Cut slope"
            onChange={(event) => setCutSlope(event.target.value)}
          />
          <input
            type="number"
            value={fillSlope}
            placeholder="Fill H:1V (2)"
            aria-label="Fill slope"
            onChange={(event) => setFillSlope(event.target.value)}
          />
          <input
            value={name}
            placeholder="Name"
            aria-label="Platform name"
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="btn btn--primary btn--sm" disabled={surfaceId === ''}>
            Add platform
          </button>
        </div>
        {error !== '' && (
          <p className="panel__error" role="alert">
            {error}
          </p>
        )}
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
