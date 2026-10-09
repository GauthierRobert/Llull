/**
 * @layer ui/panels/civil
 *
 * Drainage input forms: `add_manhole` (position, invert, rim or ground surface, catchment) and
 * `add_pipe` (upstream / downstream manholes, diameter, material, Manning n).
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { chosenId, CivilObjectSelect, useCivilObjects } from './CivilParts';
import { optionalNumber, parseNumber, parsePoints } from './civilInput';

const MANHOLE_FIELDS = [
  ['rimElevation', 'Rim elevation'],
  ['diameter', 'Diameter'],
  ['catchmentAreaHa', 'Catchment ha'],
  ['runoffCoefficient', 'Runoff C'],
  ['inflowLps', 'Inflow l/s'],
] as const;

type ManholeKey = (typeof MANHOLE_FIELDS)[number][0];

const EMPTY_MANHOLE: Record<ManholeKey, string> = {
  rimElevation: '',
  diameter: '',
  catchmentAreaHa: '',
  runoffCoefficient: '',
  inflowLps: '',
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
        <input
          value={position}
          placeholder="x,y"
          aria-label="Manhole position"
          onChange={(event) => setPosition(event.target.value)}
        />
        <input
          type="number"
          value={invert}
          placeholder="Invert elevation"
          aria-label="Manhole invert"
          onChange={(event) => setInvert(event.target.value)}
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
        <input
          value={name}
          placeholder="Name"
          aria-label="Manhole name"
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" className="btn btn--primary btn--sm">
          Add manhole
        </button>
      </div>
      {error !== '' && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}
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
      <input
        type="number"
        value={diameter}
        placeholder="Diameter"
        aria-label="Pipe diameter"
        onChange={(event) => setDiameter(event.target.value)}
      />
      <input
        value={material}
        placeholder="Material"
        aria-label="Pipe material"
        onChange={(event) => setMaterial(event.target.value)}
      />
      <input
        type="number"
        value={manningN}
        placeholder="Manning n"
        aria-label="Pipe Manning n"
        onChange={(event) => setManningN(event.target.value)}
      />
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
