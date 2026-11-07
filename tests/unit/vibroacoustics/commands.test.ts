import { describe, expect, it } from 'vitest';
import { execute, toToolSchemas } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { AcousticExposure } from '@cae/vibroacoustics/types';
import { csvRows, expectedNumbers, flatDocument, flatParams, run, THIRD_NOMINAL_27, withinCase } from './fixtures';

const nan = (value: number | undefined): number => value ?? Number.NaN;
const empty = createEmptyDocument();

const refusal = (result: ReturnType<typeof execute>): string | undefined => (result.rejected === true ? result.error?.code : undefined);

const exposure: AcousticExposure = {
  name: 'skin',
  spectrum: 'flat130',
  target: { entityId: 'box-1', facesNear: [[0, 0, 0]] },
  field: 'diffuse',
};

describe('define_acoustic_spectrum', () => {
  it('stores bands by exact mid-band frequency, sorted, with provenance (VC-VAC-05)', () => {
    const shuffled = { ...flatParams(), bands: [...flatParams().bands].reverse() };
    const result = run(empty, 'define_acoustic_spectrum', shuffled);
    const spectrum = result.document.vibroacoustics?.spectra['flat130'];
    expect(result.affected).toEqual(['flat130']);
    expect(result.document.vibroacoustics?.spectrumOrder).toEqual(['flat130']);
    expect(spectrum?.bands.map((band) => band.nominalHz)).toEqual(THIRD_NOMINAL_27);
    expect(spectrum?.bands[0]?.exactMidHz).toBeCloseTo(25.1188643151, 9);
    expect(spectrum?.reference).toBe('20uPa');
    expect(spectrum?.unverified).toBe(false);
    expect(result.summary).toContain('27 bands');
  });

  it('flags a spectrum that is not grade A as unverified with the VAC_SPECTRUM_UNVERIFIED warning', () => {
    for (const grade of ['B', 'none'] as const) {
      const result = run(empty, 'define_acoustic_spectrum', flatParams('user', 130, grade));
      expect(result.document.vibroacoustics?.spectra['user']?.unverified).toBe(true);
      expect(result.summary).toContain('VAC_SPECTRUM_UNVERIFIED');
      expect((result.data as { items: { code: string }[] }).items.map((item) => item.code)).toEqual(['VAC_SPECTRUM_UNVERIFIED']);
    }
  });

  it('is pure', () => {
    const before = structuredClone(empty);
    const result = execute(empty, 'define_acoustic_spectrum', flatParams());
    expect(empty).toEqual(before);
    expect(result.document).not.toBe(empty);
  });

  it('VC-VAC-30: a band label outside the base-10 series is refused with VAC_BAND_UNKNOWN', () => {
    const params = { ...flatParams(), bands: [{ nominalHz: 1100, splDb: 120 }] };
    const result = execute(empty, 'define_acoustic_spectrum', params);
    expect(refusal(result)).toBe('VAC_BAND_UNKNOWN');
    expect(result.document).toBe(empty);
    expect(result.affected).toEqual([]);
    expect(result.error?.paths).toEqual(['bands[0].nominalHz']);
  });

  it('refuses an octave label in a third-octave spectrum and a third label in an octave spectrum', () => {
    expect(
      refusal(
        execute(empty, 'define_acoustic_spectrum', {
          ...flatParams(),
          bands: [
            { nominalHz: 16000, splDb: 1 },
            { nominalHz: 12345, splDb: 1 },
          ],
        }),
      ),
    ).toBe('VAC_BAND_UNKNOWN');
    expect(
      refusal(execute(empty, 'define_acoustic_spectrum', { ...flatParams(), bandwidth: 'octave', bands: [{ nominalHz: 25, splDb: 1 }] })),
    ).toBe('VAC_BAND_UNKNOWN');
  });

  it('VC-VAC-31: a missing or foreign reference is refused with VAC_REFERENCE_UNSET', () => {
    const { reference: _omitted, ...withoutReference } = flatParams();
    const missing = execute(empty, 'define_acoustic_spectrum', withoutReference);
    expect(refusal(missing)).toBe('VAC_REFERENCE_UNSET');
    expect(missing.document).toBe(empty);
    expect(refusal(execute(empty, 'define_acoustic_spectrum', { ...flatParams(), reference: '1uPa' }))).toBe('VAC_REFERENCE_UNSET');
  });

  it('refuses the same band twice with VAC_BAND_DUPLICATE', () => {
    const params = {
      ...flatParams(),
      bands: [
        { nominalHz: 1000, splDb: 120 },
        { nominalHz: 1000, splDb: 121 },
      ],
    };
    expect(refusal(execute(empty, 'define_acoustic_spectrum', params))).toBe('VAC_BAND_DUPLICATE');
  });

  it('refuses an existing name with VAC_NAME_TAKEN and keeps the first spectrum', () => {
    const doc = flatDocument();
    const again = execute(doc, 'define_acoustic_spectrum', flatParams('flat130', 99));
    expect(refusal(again)).toBe('VAC_NAME_TAKEN');
    expect(again.document).toBe(doc);
  });

  it('rejects invalid params through the schema: empty bands, level out of range, reserved-looking name, no source', () => {
    for (const patch of [
      { bands: [] },
      { bands: [{ nominalHz: 1000, splDb: 400 }] },
      { name: '__proto__' },
      { name: 'constructor' },
      { name: 'prototype' },
      { name: '' },
      { source: undefined },
    ]) {
      const result = execute(empty, 'define_acoustic_spectrum', { ...flatParams(), ...patch });
      expect(result.document).toBe(empty);
      expect(result.affected).toEqual([]);
      expect(result.rejected).toBe(true);
    }
  });
});

describe('delete_acoustic_spectrum', () => {
  it('removes the spectrum and its order entry', () => {
    const result = run(flatDocument(), 'delete_acoustic_spectrum', { name: 'flat130' });
    expect(result.document.vibroacoustics?.spectra).toEqual({});
    expect(result.document.vibroacoustics?.spectrumOrder).toEqual([]);
    expect(result.affected).toEqual(['flat130']);
  });

  it('is pure', () => {
    const doc = flatDocument();
    const before = structuredClone(doc);
    execute(doc, 'delete_acoustic_spectrum', { name: 'flat130' });
    expect(doc).toEqual(before);
  });

  it('refuses an unknown name with VAC_SPECTRUM_UNKNOWN (including inherited keys)', () => {
    for (const name of ['nope', 'constructor']) {
      const result = execute(flatDocument(), 'delete_acoustic_spectrum', { name });
      expect(refusal(result)).toBe('VAC_SPECTRUM_UNKNOWN');
      expect(result.affected).toEqual([]);
    }
  });

  it('refuses a spectrum used by an exposure with VAC_SPECTRUM_IN_USE', () => {
    const base = flatDocument();
    const doc: CadDocument = {
      ...base,
      vibroacoustics: {
        ...(base.vibroacoustics as NonNullable<CadDocument['vibroacoustics']>),
        exposures: { skin: exposure },
        exposureOrder: ['skin'],
      },
    };
    const result = execute(doc, 'delete_acoustic_spectrum', { name: 'flat130' });
    expect(refusal(result)).toBe('VAC_SPECTRUM_IN_USE');
    expect(result.document).toBe(doc);
    expect(result.error?.ids).toEqual(['flat130', 'skin']);
  });
});

describe('convert_acoustic_spectrum', () => {
  it('AC-3 / VC-VAC-12: regroups thirds into a new octave spectrum and keeps the source', () => {
    const thirds = {
      name: 'tri',
      bandwidth: 'third_octave',
      reference: '20uPa',
      bands: [
        { nominalHz: 800, splDb: 128 },
        { nominalHz: 1000, splDb: 131 },
        { nominalHz: 1250, splDb: 127 },
      ],
      source: { citation: 'VC-VAC-12 input', grade: 'B' },
    };
    const doc = run(empty, 'define_acoustic_spectrum', thirds).document;
    const result = run(doc, 'convert_acoustic_spectrum', { spectrum: 'tri', to: 'octave', name: 'tri_oct' });
    const octave = result.document.vibroacoustics?.spectra['tri_oct'];
    expect(result.affected).toEqual(['tri_oct']);
    expect(octave?.bandwidth).toBe('octave');
    expect(octave?.bands).toHaveLength(1);
    expect(octave?.bands[0]?.nominalHz).toBe(1000);
    expect(octave?.bands[0]?.exactMidHz).toBe(1000);
    expect(withinCase(nan(octave?.bands[0]?.splDb), nan(expectedNumbers('VC-VAC-12')[0]), 'VC-VAC-12')).toBe(true);
    expect(octave?.source.citation).toBe('regrouped from tri: VC-VAC-12 input');
    expect(octave?.source.grade).toBe('B');
    expect(octave?.unverified).toBe(true);
    expect(result.document.vibroacoustics?.spectra['tri']).toEqual(doc.vibroacoustics?.spectra['tri']);
    expect(result.document.vibroacoustics?.spectrumOrder).toEqual(['tri', 'tri_oct']);
  });

  it('lists incomplete octaves instead of converting them', () => {
    const params = { ...flatParams('part'), bands: [800, 1000, 1250, 2000].map((nominalHz) => ({ nominalHz, splDb: 100 })) };
    const doc = run(empty, 'define_acoustic_spectrum', params).document;
    const result = run(doc, 'convert_acoustic_spectrum', { spectrum: 'part', to: 'octave', name: 'part_oct' });
    expect((result.data as { omittedOctavesHz: number[] }).omittedOctavesHz).toEqual([2000]);
    expect(result.document.vibroacoustics?.spectra['part_oct']?.bands.map((band) => band.nominalHz)).toEqual([1000]);
    expect(result.summary).toContain('omitted incomplete octave(s) 2000 Hz');
  });

  it('is pure', () => {
    const doc = flatDocument();
    const before = structuredClone(doc);
    execute(doc, 'convert_acoustic_spectrum', { spectrum: 'flat130', to: 'octave', name: 'o' });
    expect(doc).toEqual(before);
  });

  it('refuses octave -> third octave, octave -> octave and an all-incomplete spectrum with VAC_CONVERSION_UNSUPPORTED', () => {
    const doc = run(flatDocument(), 'convert_acoustic_spectrum', { spectrum: 'flat130', to: 'octave', name: 'o' }).document;
    for (const params of [
      { spectrum: 'o', to: 'third_octave', name: 'x' },
      { spectrum: 'flat130', to: 'third_octave', name: 'x' },
      { spectrum: 'o', to: 'octave', name: 'x' },
    ]) {
      const result = execute(doc, 'convert_acoustic_spectrum', params);
      expect(refusal(result)).toBe('VAC_CONVERSION_UNSUPPORTED');
      expect(result.document).toBe(doc);
    }
    const sparse = run(empty, 'define_acoustic_spectrum', { ...flatParams('s'), bands: [{ nominalHz: 1000, splDb: 90 }] }).document;
    const result = execute(sparse, 'convert_acoustic_spectrum', { spectrum: 's', to: 'octave', name: 'x' });
    expect(refusal(result)).toBe('VAC_CONVERSION_UNSUPPORTED');
    expect(result.summary).toContain('1000');
  });

  it('refuses an unknown source with VAC_SPECTRUM_UNKNOWN and a taken or invalid name', () => {
    const doc = flatDocument();
    expect(refusal(execute(doc, 'convert_acoustic_spectrum', { spectrum: 'nope', to: 'octave', name: 'o' }))).toBe('VAC_SPECTRUM_UNKNOWN');
    expect(refusal(execute(doc, 'convert_acoustic_spectrum', { spectrum: 'flat130', to: 'octave', name: 'flat130' }))).toBe(
      'VAC_NAME_TAKEN',
    );
    expect(refusal(execute(doc, 'convert_acoustic_spectrum', { spectrum: 'flat130', to: 'octave', name: '__proto__' }))).toBe(
      'VAC_PARAMS_INVALID',
    );
  });
});

describe('acoustic_level', () => {
  const level = (params: Record<string, unknown>): { pRmsPa: number; splDb: number; sumDb?: number } =>
    run(empty, 'acoustic_level', params).data as { pRmsPa: number; splDb: number; sumDb?: number };

  it('AC-1 / VC-VAC-01: 140 dB is 200 Pa', () => {
    expect(level({ splDb: 140 }).pRmsPa).toBeCloseTo(200, 10);
    const expected = expectedNumbers('VC-VAC-01');
    [94, 120, 140, 150].forEach((splDb, i) => expect(withinCase(level({ splDb }).pRmsPa, nan(expected[i]), 'VC-VAC-01')).toBe(true));
  });

  it('VC-VAC-02: 1 Pa is 93.9794 dB', () => {
    expect(withinCase(level({ pRmsPa: 1 }).splDb, nan(expectedNumbers('VC-VAC-02')[0]), 'VC-VAC-02')).toBe(true);
  });

  it('VC-VAC-08: levelsDb are summed by energy and carry sumDb', () => {
    const result = level({ levelsDb: [120, 126, 131, 128, 122] });
    expect(withinCase(result.sumDb ?? Number.NaN, nan(expectedNumbers('VC-VAC-08')[0]), 'VC-VAC-08')).toBe(true);
    expect(result.splDb).toBe(result.sumDb);
    expect(level({ splDb: 100 }).sumDb).toBeUndefined();
  });

  it('is pure and leaves the document untouched', () => {
    const before = structuredClone(empty);
    const result = execute(empty, 'acoustic_level', { splDb: 94 });
    expect(empty).toEqual(before);
    expect(result.document).toBe(empty);
    expect(result.affected).toEqual([]);
  });

  it('refuses none or several inputs with VAC_PARAMS_INVALID; the schema rejects pRmsPa <= 0 and non-finite levels', () => {
    for (const params of [{}, { splDb: 100, pRmsPa: 1 }, { splDb: 1, levelsDb: [1] }])
      expect(refusal(execute(empty, 'acoustic_level', params))).toBe('VAC_PARAMS_INVALID');
    for (const params of [{ pRmsPa: 0 }, { pRmsPa: -1 }, { splDb: Number.POSITIVE_INFINITY }, { levelsDb: [] }, { levelsDb: [1e9] }])
      expect(execute(empty, 'acoustic_level', params).rejected).toBe(true);
  });

  it('bounds pRmsPa by the pressure of the largest accepted level, and describes the name rule', () => {
    expect(execute(empty, 'acoustic_level', { pRmsPa: 2.5e10 }).rejected).toBe(true);
    expect(execute(empty, 'acoustic_level', { pRmsPa: 1.9e10 }).rejected).not.toBe(true);
    const description = toToolSchemas().find((tool) => tool.name === 'define_acoustic_spectrum')?.input_schema;
    expect(JSON.stringify(description)).toContain('[A-Za-z][A-Za-z0-9_.-]{0,63}');
  });
});

describe('acoustic_spectrum_report', () => {
  const reportOf = (doc: CadDocument, name = 'flat130'): Record<string, unknown> =>
    run(doc, 'acoustic_spectrum_report', { spectrum: name }).data as Record<string, unknown>;

  interface ReportBand {
    nominalHz: number;
    exactMidHz: number;
    lowerHz: number;
    upperHz: number;
    bandwidthHz: number;
    splDb: number;
    pRmsPa: number;
    psdPa2PerHz: number;
  }

  it('AC-2 / VC-VAC-06, 09, 10: OASPL, overall pressure and the 1 kHz band PSD', () => {
    const data = reportOf(flatDocument());
    expect(withinCase(data['oasplDb'] as number, nan(expectedNumbers('VC-VAC-06')[0]), 'VC-VAC-06')).toBe(true);
    expect(withinCase(data['pRmsPa'] as number, nan(expectedNumbers('VC-VAC-09')[0]), 'VC-VAC-09')).toBe(true);
    const bands = data['bands'] as ReportBand[];
    expect(bands).toHaveLength(27);
    const band = bands.find((entry) => entry.nominalHz === 1000);
    expect(withinCase(nan(band?.psdPa2PerHz), nan(expectedNumbers('VC-VAC-10')[0]), 'VC-VAC-10')).toBe(true);
    expect(withinCase(nan(band?.bandwidthHz), nan(expectedNumbers('VC-VAC-03')[3]), 'VC-VAC-03')).toBe(true);
    expect(data['psdKind']).toBe('band-averaged one-sided Pa^2/Hz');
    expect(data['unverified']).toBe(false);
    expect(data['items']).toEqual([]);
  });

  it('reproduces every row of example_spectrum.csv (p_rms, bandwidth, PSD)', () => {
    const bands = reportOf(flatDocument())['bands'] as ReportBand[];
    for (const row of csvRows('example_spectrum.csv')) {
      const band = bands.find((entry) => entry.nominalHz === row['nominal_Hz']);
      expect(Math.abs(nan(band?.pRmsPa) / nan(row['p_rms_Pa']) - 1)).toBeLessThan(1e-11);
      expect(Math.abs(nan(band?.bandwidthHz) / nan(row['bandwidth_Hz']) - 1)).toBeLessThan(1e-11);
      expect(Math.abs(nan(band?.psdPa2PerHz) / nan(row['psd_Pa2_per_Hz']) - 1)).toBeLessThan(1e-11);
    }
  });

  it('returns the octave regrouping of a third-octave spectrum, none for an octave spectrum', () => {
    const doc = run(flatDocument(), 'convert_acoustic_spectrum', { spectrum: 'flat130', to: 'octave', name: 'flat_oct' }).document;
    const thirds = reportOf(doc);
    expect((thirds['octaves'] as { nominalHz: number; splDb: number }[]).map((octave) => octave.nominalHz)).toEqual([
      31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000,
    ]);
    const octave = reportOf(doc, 'flat_oct');
    expect(octave['octaves']).toBeUndefined();
    expect(octave['bandwidth']).toBe('octave');
    expect(Math.abs((octave['oasplDb'] as number) - nan(expectedNumbers('VC-VAC-06')[0]))).toBeLessThan(1e-9);
  });

  it('carries VAC_SPECTRUM_UNVERIFIED for a spectrum that is not grade A', () => {
    const doc = run(empty, 'define_acoustic_spectrum', flatParams('user', 130, 'C')).document;
    const data = reportOf(doc, 'user');
    expect(data['unverified']).toBe(true);
    expect((data['items'] as { code: string; severity: string }[])[0]).toMatchObject({
      code: 'VAC_SPECTRUM_UNVERIFIED',
      severity: 'warning',
    });
  });

  it('is pure', () => {
    const doc = flatDocument();
    const before = structuredClone(doc);
    const result = execute(doc, 'acoustic_spectrum_report', { spectrum: 'flat130' });
    expect(doc).toEqual(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('refuses an unknown spectrum with VAC_SPECTRUM_UNKNOWN', () => {
    const result = execute(empty, 'acoustic_spectrum_report', { spectrum: 'nope' });
    expect(refusal(result)).toBe('VAC_SPECTRUM_UNKNOWN');
    expect(result.document).toBe(empty);
  });
});
