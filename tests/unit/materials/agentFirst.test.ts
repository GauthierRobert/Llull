import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { call, ctxWith, hashOf, libraryFile, mmDocument, SOURCE, step } from './support';

const PACK = 'docs/aerospace/08-materials-standards-libraries/validation/expected_results.json';
const pack = JSON.parse(readFileSync(PACK, 'utf8')) as {
  agentFirst: { id: string; expected: { call: string; code: string }[]; assert?: string }[];
};
const vc24 = pack.agentFirst.find((entry) => entry.id === 'VC-MAT-24');
const listed = (fragment: string): string => vc24?.expected.find((row) => row.call.includes(fragment))?.code ?? 'not listed';

const record = { id: 'r', designation: '7075', specs: [], licence: 'company-proprietary', exportMarking: { regime: 'none' } };
const hotTable = {
  mode: 'percentOfRT',
  temperatureUnit: 'degF',
  points: [
    [70, 100],
    [300, 80],
    [500, 50],
  ],
};

describe('VC-MAT-24: wrong inputs give a stable code, ids or path, and a remediation', () => {
  const base = (): ReturnType<typeof mmDocument> => {
    let doc = step(mmDocument(), 'define_material_record', record);
    doc = step(doc, 'set_material_property', {
      material: 'r',
      source: SOURCE,
      id: 'rt',
      property: 'Ftu',
      value: 60,
      unit: 'ksi',
      basis: 'S',
      preferred: true,
    });
    doc = step(doc, 'set_material_property', {
      material: 'r',
      source: SOURCE,
      id: 'hot',
      property: 'Ftu',
      unit: 'ksi',
      temperature: hotTable,
    });
    return step(doc, 'set_material_property', {
      material: 'r',
      source: SOURCE,
      id: 'rho',
      property: 'density',
      value: 2.81,
      unit: 'g/cm^3',
      basis: 'typical',
      preferred: true,
    });
  };

  const cases: ReadonlyArray<readonly [string, string, () => ReturnType<typeof call>]> = [
    [
      'unit=MPa',
      'MAT_UNIT_DIMENSION',
      () => call(base(), 'set_material_property', { material: 'r', source: SOURCE, property: 'density', value: 2.81, unit: 'MPa' }),
    ],
    [
      'Ftu value=83 unit=ksi (no basis)',
      'MAT_BASIS_MISSING',
      () => call(base(), 'set_material_property', { material: 'r', source: SOURCE, property: 'Ftu', value: 83, unit: 'ksi' }),
    ],
    [
      'second preferred density',
      'MAT_PREFERRED_CONFLICT',
      () =>
        call(base(), 'set_material_property', {
          material: 'r',
          source: SOURCE,
          id: 'rho2',
          property: 'density',
          value: 2.8,
          unit: 'g/cm^3',
          basis: 'typical',
          preferred: true,
        }),
    ],
    [
      'basis=A where only S exists',
      'MAT_ALLOWABLE_NOT_AVAILABLE',
      () => call(base(), 'get_material_allowable', { material: 'r', property: 'Ftu', basis: 'A' }),
    ],
    [
      '600 degF',
      'MAT_TEMPERATURE_OUT_OF_RANGE',
      () =>
        call(base(), 'get_material_allowable', { material: 'r', property: 'Ftu', basis: 'S', temperature: { value: 600, unit: 'degF' } }),
    ],
    [
      'licensed-no-redistribution library with storage=embedded',
      'MAT_LICENCE_EMBED_FORBIDDEN',
      () => call(mmDocument(), 'import_material_library', { library: libraryFile({ licence: 'licensed-no-redistribution' }) }),
    ],
  ];

  it.each(cases)('%s', (fragment, code, run) => {
    const result = run();
    expect(code).toBe(listed(fragment));
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe(code);
    expect(result.error?.remediation.length).toBeGreaterThan(10);
    expect((result.error?.ids.length ?? 0) + (result.error?.paths.length ?? 0)).toBeGreaterThan(0);
    expect(result.summary).toContain(code);
    expect(result.affected).toEqual([]);
  });

  it('the other listed codes (hash mismatch, unresolved library) carry the same fields', () => {
    const file = libraryFile();
    const mismatch = call(mmDocument(), 'import_material_library', { library: file, sha256: 'a'.repeat(64) });
    const unresolved = call(
      mmDocument(),
      'import_material_library',
      { libraryId: 'synthetic-lib', version: '1', sha256: hashOf(file) },
      ctxWith(null),
    );
    for (const result of [mismatch, unresolved]) {
      expect(result.error?.remediation.length).toBeGreaterThan(10);
      expect(result.error?.ids.length ?? result.error?.paths.length).toBeGreaterThan(0);
    }
  });

  it('every listed material code is covered here', () => {
    const covered = new Set(cases.map(([, code]) => code));
    const fastenerCodes = (vc24?.expected ?? []).map((row) => row.code).filter((code) => code.startsWith('FAST_'));
    expect((vc24?.expected ?? []).map((row) => row.code).filter((code) => !covered.has(code))).toEqual(fastenerCodes);
  });
});
