// Hole parameters (07 §7.3, SHOULD): gathers an `add_hole` call. Countersink angles 82 / 90 / 100 are offered as presets and labelled
// unverified: they are shortcuts for the number field, never a sourced rule. The command validates and cuts.

import React, { useState } from 'react';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import { PanelSection, FormError } from '@ui/panels/PanelParts';
import { optionalNumber, parseNumber, parseNumberRow } from '@ui/numberText';
import { useStore } from '@ui/store';
import { CSK_PRESET_ANGLES } from './ftrData';

const KINDS: ReadonlyArray<readonly [string, string]> = [
  ['simple', 'Simple'],
  ['counterbore', 'Counterbore'],
  ['countersink', 'Countersink'],
];
const EXTENTS: ReadonlyArray<readonly [string, string]> = [
  ['through_all', 'Through all'],
  ['blind', 'Blind'],
];

const INITIAL = {
  near: '',
  point: '0, 0',
  kind: 'simple',
  diameter: '',
  cskAngle: '',
  cskDiameter: '',
  cboreDiameter: '',
  cboreDepth: '',
  extent: 'through_all',
  depth: '',
};

export function HoleForm({ partId }: { partId: string }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [form, setForm] = useState(INITIAL);
  const [error, setError] = useState('');
  const set = (key: keyof typeof INITIAL) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const near = parseNumberRow(form.near);
    const point = parseNumberRow(form.point);
    const diameter = parseNumber(form.diameter);
    if (near?.length !== 3 || point?.length !== 2 || diameter === undefined) {
      setError('Give a face point as "x, y, z", a hole centre as "u, v" and a diameter.');
      return;
    }
    setError('');
    const hole = {
      kind: form.kind,
      diameter,
      ...(form.kind === 'countersink'
        ? { ...optionalNumber('cskAngle', form.cskAngle), ...optionalNumber('cskDiameter', form.cskDiameter) }
        : {}),
      ...(form.kind === 'counterbore'
        ? { ...optionalNumber('cboreDiameter', form.cboreDiameter), ...optionalNumber('cboreDepth', form.cboreDepth) }
        : {}),
    };
    const extent = form.extent === 'blind' ? { kind: 'blind', ...optionalNumber('depth', form.depth) } : { kind: 'through_all' };
    dispatch('add_hole', { target: partId, face: { near }, points: [point], hole, extent });
  };

  return (
    <PanelSection title="Add hole" collapsible defaultOpen={false} testId="mfg-hole-form">
      <form className="mfg__form" onSubmit={submit} aria-label="Add hole">
        <LabeledInput label="Face point x, y, z" type="text" value={form.near} onChange={set('near')} testId="hole-near" />
        <LabeledInput label="Centre u, v" type="text" value={form.point} onChange={set('point')} testId="hole-point" />
        <LabeledSelect label="Kind" value={form.kind} options={KINDS} onChange={set('kind')} testId="hole-kind" />
        <LabeledInput
          label="Diameter"
          type="number"
          value={form.diameter}
          onChange={set('diameter')}
          testId="hole-diameter"
          inputProps={{ step: 'any' }}
        />
        {form.kind === 'countersink' && (
          <>
            <LabeledInput
              label="Countersink angle°"
              type="number"
              value={form.cskAngle}
              onChange={set('cskAngle')}
              testId="hole-csk-angle"
              inputProps={{ step: 'any' }}
            />
            <div className="mfg__presets" role="group" aria-label="Countersink angle presets (unverified)">
              {CSK_PRESET_ANGLES.map((angle) => (
                <button
                  type="button"
                  key={angle}
                  className="btn btn--sm"
                  onClick={() => set('cskAngle')(String(angle))}
                  data-testid={`csk-preset-${angle}`}
                >
                  {angle}° <span className="finding__badge">unverified</span>
                </button>
              ))}
            </div>
            <LabeledInput
              label="Countersink diameter"
              type="number"
              value={form.cskDiameter}
              onChange={set('cskDiameter')}
              testId="hole-csk-diameter"
              inputProps={{ step: 'any' }}
            />
          </>
        )}
        {form.kind === 'counterbore' && (
          <>
            <LabeledInput
              label="Counterbore diameter"
              type="number"
              value={form.cboreDiameter}
              onChange={set('cboreDiameter')}
              inputProps={{ step: 'any' }}
            />
            <LabeledInput
              label="Counterbore depth"
              type="number"
              value={form.cboreDepth}
              onChange={set('cboreDepth')}
              inputProps={{ step: 'any' }}
            />
          </>
        )}
        <LabeledSelect label="Extent" value={form.extent} options={EXTENTS} onChange={set('extent')} testId="hole-extent" />
        {form.extent === 'blind' && (
          <LabeledInput label="Depth" type="number" value={form.depth} onChange={set('depth')} inputProps={{ step: 'any' }} />
        )}
        <FormError text={error} />
        <button type="submit" className="btn btn--primary btn--sm" data-testid="hole-submit">
          Add hole
        </button>
      </form>
    </PanelSection>
  );
}
