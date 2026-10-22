import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence/serialization';
import { call, dataOf, mmDocument, SOURCE, step } from './support';

const PACK = 'docs/aerospace/08-materials-standards-libraries/validation/expected_results.json';
const expected = JSON.parse(readFileSync(PACK, 'utf8')) as {
  unitConversion: { id: string; input: { density: number; unit: string }; expected: Record<string, number> }[];
};

const record = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  designation: '7075',
  temper: 'T6',
  productForm: 'sheet',
  specs: [{ body: 'SAE', id: 'AMS 4045' }],
  licence: 'company-proprietary',
  exportMarking: { regime: 'none' },
  ...extra,
});

const property = (material: string, extra: Record<string, unknown>): Record<string, unknown> => ({ material, source: SOURCE, ...extra });

describe('define_material_record', () => {
  it('creates a material with a record and no density yet', () => {
    const result = call(mmDocument(), 'define_material_record', record('aa7075'));
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain("define_material_record 'aa7075': created");
    expect(result.document.materials['aa7075']).toMatchObject({
      name: 'aa7075',
      density: 0,
      record: { id: 'aa7075', designation: '7075', temper: 'T6', licence: 'company-proprietary', exportMarking: { regime: 'none' } },
    });
    expect(result.document.featureHistory.at(-1)?.name).toBe('define_material_record');
  });

  it('is pure', () => {
    const doc = mmDocument();
    const before = JSON.stringify(doc);
    call(doc, 'define_material_record', record('aa7075'));
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('refuses licensed-no-redistribution: an embedded record would reach saved files, live snapshots and cad://document', () => {
    const doc = mmDocument();
    const refused = call(doc, 'define_material_record', record('aa7075', { licence: 'licensed-no-redistribution' }));
    expect(refused.document).toBe(doc);
    expect(refused.affected).toEqual([]);
    expect(refused.error).toMatchObject({ code: 'MAT_LICENCE_EMBED_FORBIDDEN', ids: ['aa7075'], paths: ['licence'] });
  });

  it('refuses an existing id without replace, and keeps the values when replacing', () => {
    let doc = step(mmDocument(), 'define_material_record', record('aa7075'));
    doc = step(doc, 'set_material_property', property('aa7075', { property: 'density', value: 2.81, unit: 'g/cm^3', basis: 'typical' }));
    const refused = call(doc, 'define_material_record', record('aa7075'));
    expect(refused.document).toBe(doc);
    expect(refused.error).toMatchObject({ code: 'MAT_RECORD_EXISTS', ids: ['aa7075'] });
    const replaced = call(doc, 'define_material_record', record('aa7075', { temper: 'T651', replace: true, color: '#112233' }));
    expect(replaced.document.materials['aa7075']).toMatchObject({ color: '#112233', record: { temper: 'T651' } });
    expect(replaced.document.materials['aa7075']?.propertyModels).toHaveLength(1);
  });

  it('refuses blank ids, bad colours, EAR without eccn and lowering the marking', () => {
    const doc = step(mmDocument(), 'define_material_record', record('m', { exportMarking: { regime: 'ITAR' } }));
    expect(call(doc, 'define_material_record', record(' ')).rejected).toBe(true);
    expect(call(doc, 'define_material_record', record('x', { color: 'red' })).error?.code).toBe('PROP_FORM_INVALID');
    expect(call(doc, 'define_material_record', record('x', { exportMarking: { regime: 'EAR' } })).error?.paths).toEqual([
      'exportMarking.eccn',
    ]);
    const lowered = call(doc, 'define_material_record', record('m', { replace: true }));
    expect(lowered.error).toMatchObject({ code: 'MAT_HUMAN_GATE', ids: ['m'] });
    expect(lowered.document).toBe(doc);
  });

  it('leaves a library record alone', () => {
    const doc = step(mmDocument(), 'import_material_library', {
      library: {
        ...{ format: 'llull-material-library' },
        schemaVersion: 1,
        id: 'l',
        version: '1',
        title: 't',
        licence: 'company-proprietary',
        exportMarking: { regime: 'none' },
        storage: 'embedded',
        sources: {},
        materials: [
          {
            id: 'lib_m',
            name: 'lib_m',
            designation: 'X',
            specs: [],
            licence: 'company-proprietary',
            exportMarking: { regime: 'none' },
            propertyModels: [],
          },
        ],
      },
    });
    expect(call(doc, 'define_material_record', record('lib_m', { replace: true })).error?.code).toBe('MAT_RECORD_READONLY');
    expect(call(doc, 'create_material', { name: 'lib_m', density: 1, color: '#ffffff', metalness: 0, roughness: 1 }).error?.code).toBe(
      'MAT_RECORD_READONLY',
    );
  });
});

describe('set_material_property', () => {
  const base = (): CadDocument => step(mmDocument(), 'define_material_record', record('ti'));

  it('VC-MAT-02: two supplier densities, one preferred, the second preferred is refused', () => {
    let doc = base();
    doc = step(
      doc,
      'set_material_property',
      property('ti', { id: 'rho.a', property: 'density', value: 0.16, unit: 'lb/in^3', basis: 'supplier_unstated', preferred: true }),
    );
    doc = step(
      doc,
      'set_material_property',
      property('ti', { id: 'rho.b', property: 'density', value: 0.163, unit: 'lb/in^3', basis: 'supplier_unstated' }),
    );
    const refused = call(
      doc,
      'set_material_property',
      property('ti', {
        id: 'rho.b',
        property: 'density',
        value: 0.163,
        unit: 'lb/in^3',
        basis: 'supplier_unstated',
        preferred: true,
        replace: true,
      }),
    );
    expect(refused.error).toMatchObject({ code: 'MAT_PREFERRED_CONFLICT', ids: ['rho.a', 'rho.b'] });
    expect(refused.error?.remediation).not.toBe('');
    const models = doc.materials['ti']?.propertyModels ?? [];
    expect(models.map((m) => m.id)).toEqual(['rho.a', 'rho.b']);
    // legacy density mirrors the preferred value: 0.16 lb/in^3 = 4.4288 g/cm^3 = 0.0044288 g/mm^3
    expect(doc.materials['ti']?.density).toBeCloseTo(0.00442878475363, 12);
    const read = dataOf(call(doc, 'get_material', { material: 'ti' }));
    expect((read['values'] as { id: string; preferred: boolean }[]).map((v) => [v.id, v.preferred])).toEqual([
      ['rho.a', true],
      ['rho.b', false],
    ]);
    expect(read['density']).toMatchObject({ available: true, basis: 'supplier_unstated', unverified: true });
  });

  it('derives a deterministic id and suffixes a clash', () => {
    let doc = base();
    doc = step(
      doc,
      'set_material_property',
      property('ti', {
        property: 'Ftu',
        value: 130,
        unit: 'ksi',
        basis: 'A',
        direction: 'L',
        thickness: { min: 0.02, max: 0.128, unit: 'in' },
      }),
    );
    doc = step(
      doc,
      'set_material_property',
      property('ti', {
        property: 'Ftu',
        value: 131,
        unit: 'ksi',
        basis: 'A',
        direction: 'L',
        thickness: { min: 0.02, max: 0.128, unit: 'in' },
      }),
    );
    expect((doc.materials['ti']?.propertyModels ?? []).map((m) => m.id)).toEqual(['Ftu.L.A.t0p02-0p128', 'Ftu.L.A.t0p02-0p128.2']);
  });

  it('VC-MAT-24: wrong units, missing basis or source, unknown property', () => {
    const doc = base();
    const dimension = call(
      doc,
      'set_material_property',
      property('ti', { property: 'density', value: 2.81, unit: 'MPa', basis: 'typical' }),
    );
    expect(dimension.error).toMatchObject({ code: 'MAT_UNIT_DIMENSION', paths: ['unit'] });
    expect(
      call(doc, 'set_material_property', property('ti', { property: 'density', value: 2.81, unit: 'furlong', basis: 'typical' })).error
        ?.code,
    ).toBe('MAT_UNIT_INVALID');
    const basis = call(doc, 'set_material_property', property('ti', { property: 'Ftu', value: 83, unit: 'ksi' }));
    expect(basis.error).toMatchObject({ code: 'MAT_BASIS_MISSING', ids: ['ti'], paths: ['basis'] });
    expect(basis.error?.remediation).toContain('basis');
    const source = call(doc, 'set_material_property', { material: 'ti', property: 'Ftu', value: 83, unit: 'ksi', basis: 'A' });
    expect(source.error?.code).toBe('MAT_PROVENANCE_MISSING');
    expect(call(doc, 'set_material_property', property('ti', { property: 'wobble', value: 1, unit: 'ksi', basis: 'A' })).error?.code).toBe(
      'PROP_PROPERTY_UNKNOWN',
    );
    expect(call(doc, 'set_material_property', property('nope', { property: 'density', value: 1, unit: 'g/cm^3' })).error?.code).toBe(
      'MAT_RECORD_NOT_FOUND',
    );
    for (const refused of [dimension, basis, source]) expect(refused.document).toBe(doc);
  });

  it('refuses a duplicate id, a missing value, bad thickness and e/D', () => {
    let doc = base();
    doc = step(doc, 'set_material_property', property('ti', { id: 'x', property: 'E', value: 10.3, unit: 'Msi', basis: 'typical' }));
    expect(
      call(doc, 'set_material_property', property('ti', { id: 'x', property: 'E', value: 10.4, unit: 'Msi', basis: 'typical' })).error
        ?.code,
    ).toBe('PROP_MODEL_EXISTS');
    const replaced = call(
      doc,
      'set_material_property',
      property('ti', { id: 'x', property: 'E', value: 10.4, unit: 'Msi', basis: 'typical', replace: true }),
    );
    expect(replaced.document.materials['ti']?.propertyModels).toHaveLength(1);
    expect(call(doc, 'set_material_property', property('ti', { property: 'E', unit: 'Msi', basis: 'typical' })).error?.paths).toEqual([
      'value',
    ]);
    expect(
      call(
        doc,
        'set_material_property',
        property('ti', { property: 'E', value: 1, unit: 'Msi', thickness: { min: 2, max: 1, unit: 'in' } }),
      ).error?.code,
    ).toBe('PROP_RANGE_INVALID');
    expect(
      call(
        doc,
        'set_material_property',
        property('ti', { property: 'E', value: 1, unit: 'Msi', thickness: { min: 1, max: 2, unit: 'bogus' } }),
      ).error?.code,
    ).toBe('MAT_UNIT_INVALID');
    expect(
      call(doc, 'set_material_property', property('ti', { property: 'Fbru', value: 1, unit: 'ksi', basis: 'A', edOverD: 0 })).error?.paths,
    ).toEqual(['edOverD']);
  });

  it('is pure and records one feature step', () => {
    const doc = base();
    const before = JSON.stringify(doc);
    const result = call(doc, 'set_material_property', property('ti', { property: 'E', value: 10.3, unit: 'Msi', basis: 'typical' }));
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document.featureHistory.at(-1)?.name).toBe('set_material_property');
    expect(result.summary).toContain("set_material_property 'ti/E.typical'");
  });

  it('stores a temperature table (absolute) and a percent-of-RT law', () => {
    let doc = base();
    doc = step(doc, 'set_material_property', property('ti', { id: 'rt', property: 'Ftu', value: 60, unit: 'ksi', basis: 'A' }));
    const pct = call(
      doc,
      'set_material_property',
      property('ti', {
        id: 'pct',
        property: 'Ftu',
        unit: 'ksi',
        temperature: {
          mode: 'percentOfRT',
          temperatureUnit: 'degF',
          points: [
            [70, 100],
            [300, 80],
            [500, 50],
          ],
        },
      }),
    );
    const model = pct.document.materials['ti']?.propertyModels?.find((m) => m.id === 'pct');
    expect(model).toMatchObject({ basis: 'A', unit: 'ksi', form: { kind: 'ratioOf', baseModelId: 'rt' } });
    expect(model?.provenance.note).toContain("model 'rt'");
    const absolute = call(
      doc,
      'set_material_property',
      property('ti', {
        id: 'abs',
        property: 'E',
        unit: 'Msi',
        basis: 'typical',
        temperature: {
          mode: 'absolute',
          temperatureUnit: 'degC',
          points: [
            [20, 10.3],
            [200, 9.5],
          ],
          exposureHours: 1000,
        },
      }),
    );
    expect(absolute.document.materials['ti']?.propertyModels?.find((m) => m.id === 'abs')).toMatchObject({
      form: { kind: 'table1d' },
      condition: { exposureHours: 1000 },
    });
  });

  it('refuses temperature input that does not fit', () => {
    let doc = base();
    const table = {
      mode: 'percentOfRT',
      temperatureUnit: 'degF',
      points: [
        [70, 100],
        [300, 80],
      ],
    };
    expect(
      call(doc, 'set_material_property', property('ti', { property: 'Ftu', unit: 'ksi', basis: 'A', temperature: table })).error?.code,
    ).toBe('PROP_MODEL_NOT_FOUND');
    doc = step(doc, 'set_material_property', property('ti', { id: 'rt1', property: 'Ftu', value: 60, unit: 'ksi', basis: 'A' }));
    doc = step(
      doc,
      'set_material_property',
      property('ti', { id: 'rt2', property: 'Ftu', value: 61, unit: 'ksi', basis: 'A', direction: 'LT' }),
    );
    expect(
      call(doc, 'set_material_property', property('ti', { property: 'Ftu', unit: 'ksi', basis: 'A', temperature: table })).error?.code,
    ).toBe('MAT_ALLOWABLE_AMBIGUOUS');
    expect(
      call(
        doc,
        'set_material_property',
        property('ti', { property: 'Ftu', unit: 'ksi', basis: 'A', temperature: { ...table, rtModelId: 'ghost' } }),
      ).error?.paths,
    ).toEqual(['temperature.rtModelId']);
    expect(
      call(
        doc,
        'set_material_property',
        property('ti', { property: 'Ftu', value: 5, unit: 'ksi', basis: 'A', temperature: { ...table, rtModelId: 'rt1' } }),
      ).error?.paths,
    ).toEqual(['value']);
    expect(
      call(
        doc,
        'set_material_property',
        property('ti', {
          property: 'Ftu',
          unit: 'ksi',
          basis: 'A',
          temperature: {
            ...table,
            points: [
              [300, 80],
              [70, 100],
            ],
            rtModelId: 'rt1',
          },
        }),
      ).error?.code,
    ).toBe('PROP_TABLE_NOT_MONOTONIC');
    expect(
      call(
        doc,
        'set_material_property',
        property('ti', {
          property: 'E',
          unit: 'Msi',
          basis: 'A',
          temperature: { mode: 'absolute', temperatureUnit: 'degF', points: [[70, 10]] },
        }),
      ).error?.paths,
    ).toEqual(['temperature.points']);
  });
});

describe('get_material and convert_quantity', () => {
  it('VC-MAT-01: a legacy material reports basis unspecified, provenance legacy, and re-saves as v3', () => {
    const doc = step(mmDocument(), 'create_material', { name: 'steel', density: 0.00785, color: '#aaaaaa', metalness: 1, roughness: 0.4 });
    const result = call(doc, 'get_material', { material: 'steel' });
    expect(dataOf(result)).toMatchObject({
      legacy: true,
      density: {
        available: true,
        basis: 'unspecified',
        provenance: 'legacy',
        unverified: true,
        unverifiedReasons: ['density given without a source'],
      },
      values: [],
    });
    const saved = JSON.parse(serializeDocument(doc)) as { version: number };
    expect(saved.version).toBe(3);
    expect(deserializeDocument(serializeDocument(doc)).materials['steel']).toEqual(doc.materials['steel']);
  });

  it('VC-MAT-01: a v2 file with legacy steel 0.00785 on a 10 mm cube loads to 7.85 g (1e-12), basis unspecified, and re-saves as v3 with the material intact', () => {
    let doc = step(mmDocument(), 'create_material', { name: 'steel', density: 0.00785, color: '#aaaaaa', metalness: 1, roughness: 0.4 });
    const added = call(doc, 'add_box', { size: [10, 10, 10] });
    const id = added.affected[0] ?? '';
    doc = step(added.document, 'assign_material', { materialName: 'steel', entityIds: [id] });
    const v2 = JSON.stringify({ ...(JSON.parse(serializeDocument(doc)) as object), version: 2 });
    expect((JSON.parse(v2) as { version: number }).version).toBe(2);
    const loaded = deserializeDocument(v2);
    const mass = dataOf(call(loaded, 'mass_properties', { entityId: id }));
    expect(Math.abs((mass['massG'] as number) / 7.85 - 1)).toBeLessThan(1e-12);
    expect(mass).toMatchObject({ unverified: true, unverifiedReasons: ['density given without a source'] });
    expect(dataOf(call(loaded, 'get_material', { material: 'steel' }))).toMatchObject({
      legacy: true,
      density: { basis: 'unspecified', provenance: 'legacy' },
    });
    const resaved = JSON.parse(serializeDocument(loaded)) as { version: number; document: CadDocument };
    expect(resaved.version).toBe(3);
    expect(resaved.document.materials['steel']).toEqual(doc.materials['steel']);
  });

  it('lists the record, its values and the marking; refuses an unknown material with the known ids', () => {
    let doc = step(
      mmDocument(),
      'define_material_record',
      record('aa7075', { superseded: { by: 'MMPDS', note: 'MIL-HDBK-5J cancelled' } }),
    );
    doc = step(
      doc,
      'set_material_property',
      property('aa7075', { property: 'Ftu', value: 83, unit: 'ksi', basis: 'typical', direction: 'L' }),
    );
    const data = dataOf(call(doc, 'get_material', { material: 'aa7075' }));
    expect(data).toMatchObject({ legacy: false, marking: { regime: 'none' }, record: { superseded: { by: 'MMPDS' } } });
    expect((data['values'] as Record<string, unknown>[])[0]).toMatchObject({
      property: 'Ftu',
      value: 83,
      unit: 'ksi',
      basis: 'typical',
      direction: 'L',
      unverified: true,
    });
    expect(data['density']).toMatchObject({ available: false, code: 'MAT_DENSITY_INVALID' });
    const missing = call(doc, 'get_material', { material: 'nope' });
    expect(missing.error?.code).toBe('MAT_RECORD_NOT_FOUND');
    expect(dataOf(missing)['materials']).toEqual(['aa7075']);
    expect(call(createEmptyDocument(), 'get_material', { material: 'x' }).rejected).toBe(true);
  });

  it('VC-MAT-03: convert_quantity matches the reference conversions', () => {
    for (const row of expected.unitConversion) {
      for (const [unit, value] of Object.entries(row.expected)) {
        const data = dataOf(call(createEmptyDocument(), 'convert_quantity', { value: row.input.density, from: row.input.unit, to: unit }));
        expect(Math.abs((data['value'] as number) / value - 1)).toBeLessThan(1e-9);
      }
    }
  });

  it('answers the factor and offset, and refuses bad or mismatched units', () => {
    const doc = createEmptyDocument();
    expect(dataOf(call(doc, 'convert_quantity', { value: 1, from: 'ksi', to: 'MPa' }))).toMatchObject({ unit: 'MPa', offset: 0 });
    const fahrenheit = dataOf(call(doc, 'convert_quantity', { value: 212, from: 'degF', to: 'degC' }));
    expect(fahrenheit['value']).toBeCloseTo(100, 10);
    expect(fahrenheit['offset']).toBeCloseTo(-160 / 9, 10);
    expect(call(doc, 'convert_quantity', { value: 1, from: 'blorp', to: 'MPa' }).error).toMatchObject({
      code: 'MAT_UNIT_INVALID',
      paths: ['from'],
    });
    expect(call(doc, 'convert_quantity', { value: 1, from: 'MPa', to: 'blorp' }).error).toMatchObject({
      code: 'MAT_UNIT_INVALID',
      paths: ['to'],
    });
    expect(call(doc, 'convert_quantity', { value: 1, from: 'MPa', to: 'g/cm^3' }).error?.code).toBe('MAT_UNIT_DIMENSION');
  });
});
