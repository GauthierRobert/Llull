/**
 * @layer ui/panels/civil
 *
 * EarthworksSection — `add_platform` (outline typed or taken from the selected polyline), each
 * platform's cut / fill (`platform_earthworks`) with a Balance button (`balance_platform`), and a
 * surface-to-surface volume comparison (`compare_surfaces`).
 */

import React, { useState } from 'react';
import type { PlatformObject } from '@core/model/civil';
import { useStore } from '@ui/store';
import { PanelSection, FormError } from '@ui/panels/PanelParts';
import {
  CivilObjectRow,
  CivilObjectSelect,
  CivilStatus,
  useCivilObjects,
  NumberField,
  PointsFromSelectionRow,
  TextField,
  useChosenId,
} from './CivilParts';
import { optionalNumber, parseNumber, optionalText } from '@ui/numberText';
import { parsePoints } from './civilInput';
import { runQuery, useCivilReport } from './civilQuery';

function PlatformRow({ platform }: { platform: PlatformObject }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [swell, setSwell] = useState('');
  const volumes = useCivilReport('platform_earthworks', 'platformId', platform.id);
  return (
    <CivilObjectRow object={platform} detail={volumes}>
      <NumberField
        value={swell}
        set={setSwell}
        hint="Swell factor"
        label={`Swell factor of ${platform.name}`}
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
  const [baseId, setBase] = useChosenId(surfaces);
  const [comparisonId, setComparison] = useChosenId(surfaces, false, 1);
  const [status, setStatus] = useState('');
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
  const [surfaceId, setSurface] = useChosenId(surfaces);
  const [outline, setOutline] = useState('');
  const [elevation, setElevation] = useState('');
  const [cutSlope, setCutSlope] = useState('');
  const [fillSlope, setFillSlope] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

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
      ...optionalText('name', name),
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
          value={outline}
          set={setOutline}
          label="Platform outline"
          noSelectionError="Select one closed polyline first."
          setError={setError}
        >
          <CivilObjectSelect
            objects={surfaces}
            value={surfaceId}
            label="Platform surface"
            onChange={setSurface}
          />
        </PointsFromSelectionRow>
        <div className="building-inline-form">
          <NumberField
            value={elevation}
            set={setElevation}
            hint="Pad elevation"
            label="Platform elevation"
          />
          <NumberField value={cutSlope} set={setCutSlope} hint="Cut H:1V (1.5)" label="Cut slope" />
          <NumberField
            value={fillSlope}
            set={setFillSlope}
            hint="Fill H:1V (2)"
            label="Fill slope"
          />
          <TextField value={name} set={setName} hint="Name" label="Platform name" />
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
