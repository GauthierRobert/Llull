/**
 * @layer ui/panels/civil
 *
 * Drainage input forms: `add_manhole` (position, invert, rim or ground surface, catchment, entry
 * time) and
 * `add_pipe` (upstream / downstream manholes, diameter, material, Manning n).
 */

import React from 'react';
import { useStore } from '@ui/store';
import {
  CivilObjectSelect,
  useCivilObjects,
  NumberTextField,
  TextField,
  useChosenId,
} from './CivilParts';
import { optionalNumber, optionalText } from '@ui/numberText';
import { manholeParamsOf } from './civilRules';
import { FormError } from '@ui/panels/PanelParts';
import { useFormValues } from '@ui/panels/useFormValues';

const PIPE_FORM = { diameter: '', material: '', manningN: '' };

const MANHOLE_FIELDS = [
  ['rimElevation', 'Rim elevation'],
  ['diameter', 'Diameter'],
  ['catchmentAreaHa', 'Catchment ha'],
  ['runoffCoefficient', 'Runoff C'],
  ['inflowLps', 'Inflow l/s'],
  ['entryTimeMin', 'Entry time min'],
] as const;

const MANHOLE_FORM = {
  position: '',
  invert: '',
  name: '',
  rimElevation: '',
  diameter: '',
  catchmentAreaHa: '',
  runoffCoefficient: '',
  inflowLps: '',
  entryTimeMin: '',
};

export function ManholeForm(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const surfaces = useCivilObjects('surface');
  const [surfaceId, setSurface] = useChosenId(surfaces, true);
  const { values, error, setError, change, field } = useFormValues(() => MANHOLE_FORM);

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const gathered = manholeParamsOf({
      position: values.position,
      invert: values.invert,
      surfaceId,
      numbers: Object.fromEntries(MANHOLE_FIELDS.map(([key]) => [key, values[key]])),
      name: values.name,
    });
    if (!gathered.ok) {
      setError(gathered.error);
      return;
    }
    dispatch('add_manhole', gathered.params);
    change('position', '');
    change('name', '');
  };

  return (
    <form className="civil-form" onSubmit={handleSubmit} aria-label="Add manhole">
      <div className="building-inline-form">
        <TextField {...field('position')} hint="x,y" label="Manhole position" />
        <NumberTextField {...field('invert')} hint="Invert elevation" label="Manhole invert" />
        <CivilObjectSelect
          objects={surfaces}
          value={surfaceId}
          label="Manhole surface"
          emptyLabel="Rim not from a surface"
          onChange={setSurface}
        />
      </div>
      <div className="building-inline-form">
        {MANHOLE_FIELDS.map(([key, placeholder]) => (
          <NumberTextField
            key={key}
            {...field(key)}
            hint={placeholder}
            label={`Manhole ${placeholder.toLowerCase()}`}
          />
        ))}
        <TextField {...field('name')} hint="Name" label="Manhole name" />
        <button type="submit" className="btn btn--primary btn--sm">
          Add manhole
        </button>
      </div>
      <FormError text={error} />
    </form>
  );
}

export function PipeForm(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const manholes = useCivilObjects('manhole');
  const [fromId, setFrom] = useChosenId(manholes);
  const [toId, setTo] = useChosenId(manholes, false, 1);
  const { values, field } = useFormValues(() => PIPE_FORM);

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (fromId === '' || toId === '' || fromId === toId) return;
    dispatch('add_pipe', {
      fromId,
      toId,
      ...optionalNumber('diameter', values.diameter),
      ...optionalText('material', values.material),
      ...optionalNumber('manningN', values.manningN),
    });
  };

  return (
    <form className="building-inline-form" onSubmit={handleSubmit} aria-label="Add pipe">
      <CivilObjectSelect objects={manholes} value={fromId} label="Pipe from" onChange={setFrom} />
      <CivilObjectSelect objects={manholes} value={toId} label="Pipe to" onChange={setTo} />
      <NumberTextField {...field('diameter')} hint="Diameter" label="Pipe diameter" />
      <TextField {...field('material')} hint="Material" label="Pipe material" />
      <NumberTextField {...field('manningN')} hint="Manning n" label="Pipe Manning n" />
      <button
        type="submit"
        className="btn btn--primary btn--sm"
        disabled={manholes.length < 2 || fromId === toId}
      >
        Add pipe
      </button>
    </form>
  );
}
