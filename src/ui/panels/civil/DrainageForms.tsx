/**
 * @layer ui/panels/civil
 *
 * Drainage input forms: `add_manhole` (position, invert, rim or ground surface, catchment, entry
 * time) and
 * `add_pipe` (upstream / downstream manholes, diameter, material, Manning n).
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { chosenId, CivilObjectSelect, useCivilObjects, NumberField, TextField } from './CivilParts';
import { optionalNumber, parseNumber } from '@ui/numberText';
import { parsePoints } from './civilInput';
import { FormError } from '@ui/panels/PanelParts';

const MANHOLE_FIELDS = [
  ['rimElevation', 'Rim elevation'],
  ['diameter', 'Diameter'],
  ['catchmentAreaHa', 'Catchment ha'],
  ['runoffCoefficient', 'Runoff C'],
  ['inflowLps', 'Inflow l/s'],
  ['entryTimeMin', 'Entry time min'],
] as const;

type ManholeKey = (typeof MANHOLE_FIELDS)[number][0];

const EMPTY_MANHOLE: Record<ManholeKey, string> = {
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
  const [position, setPosition] = useState('');
  const [invert, setInvert] = useState('');
  const [surface, setSurface] = useState('');
  const [fields, setFields] = useState(EMPTY_MANHOLE);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const surfaceId = chosenId(surfaces, surface, true);

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const at = parsePoints(position);
    const invertElevation = parseNumber(invert);
    if (at?.length !== 1 || invertElevation === undefined) {
      setError('Enter the position "x,y" and the invert elevation.');
      return;
    }
    dispatch('add_manhole', {
      location: at[0],
      invertElevation,
      ...(surfaceId !== '' ? { surfaceId } : {}),
      ...MANHOLE_FIELDS.reduce(
        (params, [key]) => ({ ...params, ...optionalNumber(key, fields[key]) }),
        {},
      ),
      ...(name.trim() !== '' ? { name: name.trim() } : {}),
    });
    setError('');
    setPosition('');
    setName('');
  };

  return (
    <form className="civil-form" onSubmit={handleSubmit} aria-label="Add manhole">
      <div className="building-inline-form">
        <TextField value={position} set={setPosition} hint="x,y" label="Manhole position" />
        <NumberField
          value={invert}
          set={setInvert}
          hint="Invert elevation"
          label="Manhole invert"
        />
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
          <input
            key={key}
            type="number"
            value={fields[key]}
            placeholder={placeholder}
            aria-label={`Manhole ${placeholder.toLowerCase()}`}
            onChange={(event) => setFields((prev) => ({ ...prev, [key]: event.target.value }))}
          />
        ))}
        <TextField value={name} set={setName} hint="Name" label="Manhole name" />
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
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [diameter, setDiameter] = useState('');
  const [material, setMaterial] = useState('');
  const [manningN, setManningN] = useState('');
  const fromId = chosenId(manholes, from);
  const toId = chosenId(manholes, to !== '' ? to : (manholes[1]?.id ?? ''));

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (fromId === '' || toId === '' || fromId === toId) return;
    dispatch('add_pipe', {
      fromId,
      toId,
      ...optionalNumber('diameter', diameter),
      ...(material.trim() !== '' ? { material: material.trim() } : {}),
      ...optionalNumber('manningN', manningN),
    });
  };

  return (
    <form className="building-inline-form" onSubmit={handleSubmit} aria-label="Add pipe">
      <CivilObjectSelect objects={manholes} value={fromId} label="Pipe from" onChange={setFrom} />
      <CivilObjectSelect objects={manholes} value={toId} label="Pipe to" onChange={setTo} />
      <NumberField value={diameter} set={setDiameter} hint="Diameter" label="Pipe diameter" />
      <TextField value={material} set={setMaterial} hint="Material" label="Pipe material" />
      <NumberField value={manningN} set={setManningN} hint="Manning n" label="Pipe Manning n" />
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
