/**
 * @layer ui/panels/civil
 *
 * CivilCrsSection — coordinate reference system (`set_coordinate_system`) and local-to-grid site
 * calibration (`set_site_calibration`). Param gathering only; the commands validate.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { PanelSection } from '@ui/panels/PanelParts';
import { optionalNumber, parseNumber, parsePoints } from './civilInput';
import { NumberField, TextField } from './CivilParts';

export function CivilCrsSection(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const crs = useStore((s) => s.document.civil?.crs);
  const [name, setName] = useState('');
  const [epsg, setEpsg] = useState('');
  const [datum, setDatum] = useState('');
  const [localOrigin, setLocalOrigin] = useState('');
  const [gridOrigin, setGridOrigin] = useState('');
  const [rotation, setRotation] = useState('');
  const [scale, setScale] = useState('');
  const [status, setStatus] = useState('');

  const applyCrs = (event: React.FormEvent): void => {
    event.preventDefault();
    if (name.trim() === '') return;
    dispatch('set_coordinate_system', {
      name: name.trim(),
      ...optionalNumber('epsg', epsg),
      ...(datum.trim() !== '' ? { verticalDatum: datum.trim() } : {}),
    });
  };

  const applyCalibration = (event: React.FormEvent): void => {
    event.preventDefault();
    const local = parsePoints(localOrigin);
    const grid = parsePoints(gridOrigin);
    if (local?.length !== 1 || grid?.length !== 1) {
      setStatus('Calibration: local and grid origin are each one "x, y" point.');
      return;
    }
    dispatch('set_site_calibration', {
      localOrigin: local[0],
      gridOrigin: grid[0],
      ...optionalNumber('rotationDeg', rotation),
      ...(parseNumber(scale) !== undefined ? optionalNumber('scaleFactor', scale) : {}),
    });
    setStatus('');
  };

  const calibration = crs?.calibration;
  return (
    <PanelSection
      title="Coordinate system"
      hint="Projected CRS and local-to-grid calibration; exports and sheets then use grid coordinates."
      collapsible
      testId="civil-crs"
    >
      <form className="civil-form" onSubmit={applyCrs} aria-label="Coordinate system">
        <div className="building-inline-form">
          <TextField value={name} set={setName} hint="CRS name" label="CRS name" />
          <NumberField value={epsg} set={setEpsg} hint="EPSG" label="EPSG code" />
          <TextField value={datum} set={setDatum} hint="Vertical datum" label="Vertical datum" />
          <button type="submit" className="btn btn--primary btn--sm" disabled={name.trim() === ''}>
            Set CRS
          </button>
        </div>
      </form>
      <form className="civil-form" onSubmit={applyCalibration} aria-label="Site calibration">
        <div className="building-inline-form">
          <TextField
            value={localOrigin}
            set={setLocalOrigin}
            hint="Local x, y"
            label="Local origin"
          />
          <TextField value={gridOrigin} set={setGridOrigin} hint="Grid E, N" label="Grid origin" />
          <NumberField value={rotation} set={setRotation} hint="Rotation deg" label="Rotation" />
          <NumberField value={scale} set={setScale} hint="Scale factor" label="Scale factor" />
          <button type="submit" className="btn btn--primary btn--sm">
            Calibrate
          </button>
        </div>
      </form>
      {crs && (
        <p className="civil-status" data-testid="civil-crs-current">
          {crs.name}
          {crs.epsg !== undefined ? ` (EPSG:${crs.epsg})` : ''}
          {calibration
            ? ` — calibrated, rotation ${calibration.rotationDeg}°, scale ${calibration.scaleFactor}`
            : ' — not calibrated'}
        </p>
      )}
      {status !== '' && <p className="civil-status">{status}</p>}
    </PanelSection>
  );
}
