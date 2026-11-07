import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { vibroacousticsPlugin as plugin } from '@cae/index';
import { vibroacousticsErrors } from '@cae/vibroacoustics/model';
import { flatDocument, run } from './fixtures';

/** A valid raw slice from real commands, as persistence sees it (deep copy of the JSON). */
const rawSlice = (): Record<string, unknown> => {
  const doc = run(flatDocument(), 'convert_acoustic_spectrum', { spectrum: 'flat130', to: 'octave', name: 'flat_oct' }).document;
  return JSON.parse(JSON.stringify(doc.vibroacoustics)) as Record<string, unknown>;
};

/** Replaces the value at a dotted path (array indices are numbers in the path) by `edit(current)`; `undefined` deletes the key. */
function update(root: Record<string, unknown>, path: string, edit: (current: unknown) => unknown): void {
  const keys = path.split('.');
  const last = keys.pop() ?? '';
  const parent = keys.reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, root);
  const next = edit(parent[last]);
  if (next === undefined) delete parent[last];
  else parent[last] = next;
}

const errorsAfter = (...edits: [string, (current: unknown) => unknown][]): string[] => {
  const slice = rawSlice();
  for (const [path, edit] of edits) update(slice, path, edit);
  return vibroacousticsErrors({ vibroacoustics: slice });
};

const set = (value: unknown) => (): unknown => value;

describe('plugin physics-vibroacoustics (TR-VAC-01, VC-VAC-35)', () => {
  it('is installed in the analysis toolset with the five M1 commands', () => {
    expect(plugin.name).toBe('physics-vibroacoustics');
    expect(plugin.toolset).toBe('analysis');
    expect(plugin.commands.map((command) => command.name).sort()).toEqual([
      'acoustic_level',
      'acoustic_spectrum_report',
      'convert_acoustic_spectrum',
      'define_acoustic_spectrum',
      'delete_acoustic_spectrum',
    ]);
  });

  it('validate accepts an absent slice and the slice the commands produce; restore is the identity (round trip deep-equals)', () => {
    expect(vibroacousticsErrors({})).toEqual([]);
    const raw = { vibroacoustics: rawSlice() };
    expect(vibroacousticsErrors(raw)).toEqual([]);
    expect(plugin.document?.validate(raw)).toEqual([]);
    expect(plugin.document?.restore(raw)).toEqual(raw);
    expect(plugin.document?.derivedEntityIds(createEmptyDocument()).size).toBe(0);
  });

  it('validate names the path of each defect', () => {
    expect(errorsAfter(['spectra.flat130.bands.0.nominalHz', set(26)])).toContain(
      'vibroacoustics.spectra.flat130.bands[0].nominalHz: is not a nominal label of the band system',
    );
    expect(errorsAfter(['spectra.flat130.bands.0.exactMidHz', set(25)])[0]).toContain(
      'bands[0].exactMidHz: does not match its nominal label',
    );
    expect(errorsAfter(['spectra.flat130.bands', (bands) => [...(bands as unknown[])].reverse()]).join('|')).toContain(
      'bands must be sorted and unique',
    );
    expect(errorsAfter(['spectra.flat130.bands.1.splDb', set(1e9)])[0]).toContain('bands[1].splDb');
    expect(errorsAfter(['spectra.flat130.unverified', set(true)])[0]).toContain('must be true unless grade is A');
    expect(errorsAfter(['spectra.flat130.reference', set('1uPa')])[0]).toContain('reference');
    expect(errorsAfter(['spectra.flat130.name', set('other')])[0]).toContain("must equal its key 'flat130'");
    expect(errorsAfter(['spectrumOrder', (order) => (order as unknown[]).slice(1)])[0]).toContain(
      'spectrumOrder: must list each spectrum key exactly once',
    );
    expect(errorsAfter(['spectrumOrder', (order) => [...(order as unknown[]), 'flat130']])[0]).toContain('spectrumOrder');
    expect(errorsAfter(['exposures', set(undefined)])[0]).toContain('exposures');
    expect(errorsAfter(['spectra.flat130.name', set('constructor')]).join('|')).toContain('Invalid string');
  });

  it('validate checks exposures: shape, name = key, spectrum reference, order', () => {
    const exposure = { name: 'skin', spectrum: 'flat130', target: { entityId: 'b', facesNear: [[0, 0, 0]] }, field: 'diffuse' };
    const withExposure = (patch: Record<string, unknown> = {}): string[] =>
      errorsAfter(['exposures', set({ skin: { ...exposure, ...patch } })], ['exposureOrder', set(['skin'])]);
    expect(withExposure()).toEqual([]);
    expect(withExposure({ spectrum: 'gone' })[0]).toContain("names no spectrum 'gone'");
    expect(withExposure({ name: 'x' })[0]).toContain("must equal its key 'skin'");
    expect(withExposure({ field: 'random' })[0]).toContain('exposures.skin.field');
    expect(withExposure({ target: { entityId: 'b', facesNear: [[0, 0]] } })[0]).toContain('facesNear');
  });

  it('accepts an exactMidHz that differs by one ulp (relative 1e-12) and refuses a larger drift', () => {
    const mid =
      (rawSlice()['spectra'] as Record<string, { bands: { exactMidHz: number }[] }>)['flat130']?.bands[0]?.exactMidHz ?? Number.NaN;
    const ulp = mid * (1 + Number.EPSILON);
    expect(ulp).not.toBe(mid);
    expect(errorsAfter(['spectra.flat130.bands.0.exactMidHz', set(ulp)])).toEqual([]);
    expect(errorsAfter(['spectra.flat130.bands.0.exactMidHz', set(mid * (1 + 1e-9))])[0]).toContain('does not match its nominal label');
  });

  it('bounds the slice: bands, incidence angle, face count and entity id shape', () => {
    const exposure = { name: 'skin', spectrum: 'flat130', target: { entityId: 'box-2.1', facesNear: [[0, 0, 0]] }, field: 'progressive' };
    const withExposure = (patch: Record<string, unknown>, facesNear?: unknown): string[] =>
      errorsAfter(
        [
          'exposures',
          set({ skin: { ...exposure, ...patch, ...(facesNear === undefined ? {} : { target: { entityId: 'box-2.1', facesNear } }) } }),
        ],
        ['exposureOrder', set(['skin'])],
      );
    expect(withExposure({ incidenceDeg: 45 })).toEqual([]);
    expect(withExposure({ incidenceDeg: 91 })[0]).toContain('incidenceDeg');
    expect(withExposure({ incidenceDeg: -1 })[0]).toContain('incidenceDeg');
    expect(withExposure({}, [])[0]).toContain('facesNear');
    expect(
      withExposure(
        {},
        Array.from({ length: 1001 }, () => [0, 0, 0]),
      )[0],
    ).toContain('facesNear');
    expect(withExposure({ target: { entityId: 'a b', facesNear: [[0, 0, 0]] } })[0]).toContain('entityId');
    const bands = Array.from({ length: 31 }, (_, i) => ({ nominalHz: 25, exactMidHz: 25.1188643151 + i, splDb: 100 }));
    expect(errorsAfter(['spectra.flat130.bands', set(bands)]).join('|')).toContain('bands');
  });

  it('validate never throws on hostile shapes', () => {
    for (const bad of [
      null,
      1,
      'x',
      [],
      { spectra: 5 },
      { spectra: {}, spectrumOrder: {}, exposures: {}, exposureOrder: [] },
      { extra: 1 },
    ])
      expect(vibroacousticsErrors({ vibroacoustics: bad }).length).toBeGreaterThan(0);
  });

  it('the saved JSON of a document validates and its spectrum reports the same after the round trip', () => {
    const doc = flatDocument();
    const saved = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    expect(vibroacousticsErrors(saved)).toEqual([]);
    const reloaded = { ...doc, vibroacoustics: saved['vibroacoustics'] } as typeof doc;
    expect(execute(reloaded, 'acoustic_spectrum_report', { spectrum: 'flat130' }).data).toEqual(
      execute(doc, 'acoustic_spectrum_report', { spectrum: 'flat130' }).data,
    );
  });
});
