// CRS (`set_coordinate_system`) and local-to-grid site calibration (`set_site_calibration`).

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { PanelSection } from '@ui/panels/PanelParts';
import { optionalNumber, optionalText } from '@ui/numberText';
import { parsePoints } from './civilInput';
import { NumberTextField, TextField } from './CivilParts';
import { useFormValues } from '@ui/panels/useFormValues';

const CRS_FORM = { name: '', epsg: '', datum: '', localOrigin: '', gridOrigin: '', rotation: '', scale: '' };

export function CivilCrsSection({ defaultOpen = true }: { defaultOpen?: boolean }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const crs = useStore((s) => s.document.civil?.crs);
  const { values, field } = useFormValues(() => CRS_FORM);
  const [status, setStatus] = useState('');

  const applyCrs = (event: React.FormEvent): void => {
    event.preventDefault();
    if (values.name.trim() === '') return;
    dispatch('set_coordinate_system', {
      name: values.name.trim(),
      ...optionalNumber('epsg', values.epsg),
      ...optionalText('verticalDatum', values.datum),
    });
  };

  const applyCalibration = (event: React.FormEvent): void => {
    event.preventDefault();
    const local = parsePoints(values.localOrigin);
    const grid = parsePoints(values.gridOrigin);
    if (local?.length !== 1 || grid?.length !== 1) {
      setStatus('Calibration: local and grid origin are each one "x, y" point.');
      return;
    }
    dispatch('set_site_calibration', {
      localOrigin: local[0],
      gridOrigin: grid[0],
      ...optionalNumber('rotationDeg', values.rotation),
      ...optionalNumber('scaleFactor', values.scale),
    });
    setStatus('');
  };

  const calibration = crs?.calibration;
  return (
    <PanelSection
      title="Coordinate system"
      hint="Projected CRS and local-to-grid calibration; exports and sheets then use grid coordinates."
      collapsible
      defaultOpen={defaultOpen}
      testId="civil-crs"
    >
      <form className="civil-form" onSubmit={applyCrs} aria-label="Coordinate system">
        <div className="building-inline-form">
          <TextField {...field('name')} hint="e.g. Belgian Lambert 2008" label="CRS name" />
          <NumberTextField {...field('epsg')} hint="e.g. 3812" label="EPSG code" />
          <TextField {...field('datum')} hint="e.g. TAW-DNG" label="Vertical datum" />
          <button type="submit" className="btn btn--primary btn--sm" disabled={values.name.trim() === ''}>
            Set CRS
          </button>
        </div>
      </form>
      <form className="civil-form" onSubmit={applyCalibration} aria-label="Site calibration">
        <div className="building-inline-form">
          <TextField {...field('localOrigin')} hint="x, y (site)" label="Local origin" />
          <TextField {...field('gridOrigin')} hint="E, N (grid)" label="Grid origin" />
          <NumberTextField {...field('rotation')} hint="0" label="Rotation (°)" />
          <NumberTextField {...field('scale')} hint="1" label="Scale factor" />
          <button type="submit" className="btn btn--primary btn--sm">
            Calibrate
          </button>
        </div>
      </form>
      {crs && (
        <p className="civil-status" data-testid="civil-crs-current">
          {crs.name}
          {crs.epsg !== undefined ? ` (EPSG:${crs.epsg})` : ''}
          {calibration ? ` — calibrated, rotation ${calibration.rotationDeg}°, scale ${calibration.scaleFactor}` : ' — not calibrated'}
        </p>
      )}
      {status !== '' && <p className="civil-status">{status}</p>}
    </PanelSection>
  );
}
