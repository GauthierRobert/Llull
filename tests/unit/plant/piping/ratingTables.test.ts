/** Plant 01 PSC M5: `import_rating_table` / `export_rating_table`, imported tables in `pt_rating`, `check_pipe_spec` and `list_piping_catalogs`. The numbers are synthetic test data, never shipped. */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { pipingCatalogErrors } from '@aec/plant/catalog/document';
import { ratingTableById } from '@aec/plant/catalog/ptRating';
import { importedRatingTable, importedRatingTables } from '@aec/plant/catalog/store';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { importedDoc, mixSpec } from './specFixture';

const empty = createEmptyDocument();
const SOURCE = { citation: 'synthetic unit-test table, not a standard value' };
type Json = Record<string, unknown>;

const enTable = (over: Json = {}): Json => ({
  format: 'llull-rating-table',
  schemaVersion: 1,
  id: 'en-pn-test',
  standard: 'EN 1092-1',
  materialGroup: 'test-1',
  licence: 'company-proprietary',
  pressureUnit: 'bar',
  temperatureUnit: 'C',
  minTemperature: -10,
  provenance: SOURCE,
  rows: [
    { pn: 16, temperature: 20, pressure: 16, verified: true },
    { pn: 16, temperature: 120, pressure: 14.4 },
    { pn: 16, temperature: 220, pressure: 12.1, provenance: { sourceId: 'T-ROW' } },
    { pn: 40, temperature: 20, pressure: 40 },
    { pn: 40, temperature: 120, pressure: 36 },
  ],
  ...over,
});
const withTable = apply(empty, 'import_rating_table', { table: enTable() });
const exported = (doc: CadDocument, tableId?: string): { text: string; sha256: string; rows: number } =>
  data<{ text: string; sha256: string; rows: number }>(doc, 'export_rating_table', tableId === undefined ? {} : { tableId });

describe('import_rating_table', () => {
  it('stores the table in bar and degC, rows sorted, unverified unless the file says so, provenance on every row', () => {
    const result = ok(empty, 'import_rating_table', { table: enTable() });
    expect(result.data).toMatchObject({ tableId: 'en-pn-test', rows: 5, unverifiedRows: 4, replaced: false });
    const table = withTable.plant?.catalog?.ratingTables?.['en-pn-test'];
    expect(table?.rows.map((row) => [row.ratingClass, row.temperatureC])).toEqual([
      [16, 20],
      [16, 120],
      [16, 220],
      [40, 20],
      [40, 120],
    ]);
    expect(table?.rows[0]?.bar).toMatchObject({ value: 16, verified: true, provenance: SOURCE });
    expect(table?.rows[2]?.bar.provenance).toEqual({ sourceId: 'T-ROW' });
  });

  it('converts psi and degF and rounds to 1e-6', () => {
    const doc = apply(empty, 'import_rating_table', {
      table: enTable({
        id: 'psi-test',
        standard: 'ASME B16.34',
        materialGroup: 'psi-1',
        pressureUnit: 'psi',
        temperatureUnit: 'F',
        minTemperature: 14,
        rows: [{ class: 150, temperature: 212, pressure: 285 }],
      }),
    });
    const row = doc.plant?.catalog?.ratingTables?.['psi-test']?.rows[0];
    expect(row?.temperatureC).toBe(100);
    expect(row?.bar.value).toBe(19.650058);
    expect(doc.plant?.catalog?.ratingTables?.['psi-test']?.minTemperatureC).toBe(-10);
  });

  it('re-importing identical content is a no-op; changed content needs replace', () => {
    const again = ok(withTable, 'import_rating_table', { table: enTable() });
    expect(again.document).toBe(withTable);
    expect(again.data).toMatchObject({ unchanged: true });
    const changed = enTable({ rows: [{ pn: 16, temperature: 20, pressure: 15 }] });
    expectRefusal(withTable, 'import_rating_table', { table: changed }, 'PSC_CATALOG_CONFLICT', 'id');
    const replaced = ok(withTable, 'import_rating_table', { table: changed, replace: true });
    expect(replaced.data).toMatchObject({ replaced: true, rows: 1 });
    expectPure(withTable, () => execute(withTable, 'import_rating_table', { table: changed, replace: true }));
  });

  it('keeps the other slice members (catalogues) when a table is added', () => {
    const catalog = apply(empty, 'import_piping_catalog', {
      catalog: {
        format: 'llull-piping-catalog',
        schemaVersion: 1,
        id: 'c',
        licence: 'open-data',
        families: [{ id: 'f', type: 'pipe', standard: 'ASME B36.10M', sizes: [{ nps: 2, outsideDiameter: 60.3, provenance: SOURCE }] }],
      },
    });
    const both = apply(catalog, 'import_rating_table', { table: enTable() });
    expect(Object.keys(both.plant?.catalog?.catalogs ?? {})).toEqual(['c']);
    const again = apply(both, 'import_piping_catalog', {
      catalog: {
        format: 'llull-piping-catalog',
        schemaVersion: 1,
        id: 'd',
        licence: 'open-data',
        families: [{ id: 'f', type: 'pipe', standard: 'ASME B36.10M', sizes: [{ nps: 3, outsideDiameter: 88.9, provenance: SOURCE }] }],
      },
    });
    expect(Object.keys(again.plant?.catalog?.ratingTables ?? {})).toEqual(['en-pn-test']);
  });

  const refusals: Array<[string, Json, string, string]> = [
    [
      'a row without provenance',
      { provenance: undefined, rows: [{ pn: 16, temperature: 20, pressure: 16 }] },
      'PSC_PROVENANCE_MISSING',
      'rows.0',
    ],
    ['a row with both class and pn', { rows: [{ class: 150, pn: 16, temperature: 20, pressure: 16 }] }, 'PSC_CATALOG_INVALID', 'rows.0'],
    ['a row with neither class nor pn', { rows: [{ temperature: 20, pressure: 16 }] }, 'PSC_CATALOG_INVALID', 'rows.0'],
    [
      'a duplicate class and temperature',
      {
        rows: [
          { pn: 16, temperature: 20, pressure: 16 },
          { pn: 16, temperature: 20, pressure: 15 },
        ],
      },
      'PSC_CATALOG_INVALID',
      'rows.1',
    ],
    [
      'a temperature below minTemperature',
      { rows: [{ pn: 16, temperature: -50, pressure: 16 }] },
      'PSC_CATALOG_INVALID',
      'rows.0.temperature',
    ],
    ['a negative pressure', { rows: [{ pn: 16, temperature: 20, pressure: -1 }] }, 'PSC_CATALOG_INVALID', 'rows.0.pressure'],
    ['a pressure that is not a number', { rows: [{ pn: 16, temperature: 20, pressure: '16' }] }, 'PSC_CATALOG_INVALID', 'rows.0.pressure'],
    ['a pressure unit that is not bar or psi', { pressureUnit: 'MPa' }, 'PSC_UNIT_INVALID', 'pressureUnit'],
    ['a temperature unit that is not C or F', { temperatureUnit: 'K' }, 'PSC_UNIT_INVALID', 'temperatureUnit'],
    ['no minTemperature (nothing is assumed)', { minTemperature: undefined }, 'PSC_CATALOG_INVALID', 'minTemperature'],
    ['an unknown standard', { standard: 'DIN 2401' }, 'PSC_CATALOG_INVALID', 'standard'],
    ['no rows', { rows: [] }, 'PSC_CATALOG_INVALID', 'rows'],
    [
      'more than 5000 rows',
      { rows: Array.from({ length: 5001 }, (_, at) => ({ pn: 16, temperature: at, pressure: 1 })) },
      'PSC_CATALOG_INVALID',
      'rows',
    ],
    ['licensed-no-redistribution', { licence: 'licensed-no-redistribution' }, 'PSC_LICENCE_EMBED_FORBIDDEN', 'licence'],
    ['the bundled id', { id: 'asme-b16.5-group-1.1' }, 'PSC_CATALOG_CONFLICT', 'id'],
    ['an id that breaks the pattern', { id: 'a b' }, 'PSC_CATALOG_INVALID', 'id'],
    ['a second table for the same standard and group', { id: 'other-id' }, 'PSC_CATALOG_CONFLICT', 'standard'],
    [
      'a second table for the bundled standard and group',
      { id: 'b165', standard: 'ASME B16.5', materialGroup: '1.1', rows: [{ class: 150, temperature: 20, pressure: 20 }] },
      'PSC_CATALOG_CONFLICT',
      'standard',
    ],
  ];
  for (const [name, over, code, path] of refusals)
    it(`refuses ${name}`, () => {
      const base = name.startsWith('a second table') ? withTable : empty;
      const result = expectRefusal(base, 'import_rating_table', { table: enTable(over) }, code, path);
      expect(result.summary).toContain('import_rating_table');
    });
});

describe('export_rating_table', () => {
  it('exports the canonical file; importing it under a new id and exporting again gives the same hash modulo the id', () => {
    const first = exported(withTable, 'en-pn-test');
    const file = JSON.parse(first.text) as Json;
    expect(file).toMatchObject({ format: 'llull-rating-table', pressureUnit: 'bar', temperatureUnit: 'C', minTemperature: -10 });
    const copy = apply(empty, 'import_rating_table', { table: { ...file, id: 'copy-id' } });
    expect(exported(copy, 'copy-id').text).toBe(first.text.replace('"id":"en-pn-test"', '"id":"copy-id"'));
    expect(exported(withTable, 'en-pn-test').sha256).toBe(first.sha256);
  });

  it('exports the bundled B16.5 table and it re-imports under another id for another group with every row, flag and source', () => {
    const bundled = exported(empty);
    expect(bundled.rows).toBe(15);
    const file = JSON.parse(bundled.text) as Json;
    const copy = apply(empty, 'import_rating_table', { table: { ...file, id: 'b165-copy', materialGroup: '1.1-copy' } });
    const again = JSON.parse(exported(copy, 'b165-copy').text) as Json;
    expect(again['rows']).toEqual(file['rows']);
  });

  it('looks tables up by own keys only (the engine refuses such ids earlier; the store must not rely on it)', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(importedRatingTable(withTable, name)).toBeUndefined();
      expect(ratingTableById(withTable, name)).toBeUndefined();
    }
    expect(importedRatingTable(withTable, 'en-pn-test')?.id).toBe('en-pn-test');
    expect(importedRatingTables(withTable).map((table) => table.id)).toEqual(['en-pn-test']);
  });

  it('refuses an unknown table', () => {
    expectRefusal(empty, 'export_rating_table', { tableId: 'nope' }, 'PSC_CATALOG_UNKNOWN', 'tableId');
  });
});

describe('imported tables are used', () => {
  it('pt_rating finds the table by standard and group or by tableId, interpolating inside the table only', () => {
    const byGroup = data<Json>(withTable, 'pt_rating', { standard: 'EN 1092-1', materialGroup: 'test-1', class: 16, temperatureC: 70 });
    expect(byGroup).toMatchObject({ tableId: 'en-pn-test', ratingBar: 15.2, method: 'interpolated', verified: false });
    const byId = data<Json>(withTable, 'pt_rating', {
      standard: 'x',
      materialGroup: 'x',
      tableId: 'en-pn-test',
      class: 40,
      temperatureC: 20,
    });
    expect(byId).toMatchObject({ ratingBar: 40, verified: false });
    expectRefusal(
      withTable,
      'pt_rating',
      { standard: 'EN 1092-1', materialGroup: 'test-1', class: 16, temperatureC: 300 },
      'PSC_PT_TEMPERATURE_OUT_OF_TABLE',
      'temperatureC',
    );
    expectRefusal(
      withTable,
      'pt_rating',
      { standard: 'EN 1092-1', materialGroup: 'test-1', class: 25, temperatureC: 20 },
      'PSC_CATALOG_ROW_MISSING',
      'class',
    );
    expectRefusal(
      withTable,
      'pt_rating',
      { standard: 'EN 1092-1', materialGroup: 'test-1', tableId: 'nope', class: 16, temperatureC: 20 },
      'PSC_CATALOG_ROW_MISSING',
      'tableId',
    );
    expectRefusal(
      empty,
      'pt_rating',
      { standard: 'EN 1092-1', materialGroup: 'test-1', class: 16, temperatureC: 20 },
      'PSC_CATALOG_ROW_MISSING',
      'standard',
    );
  });

  it('check_pipe_spec checks a PN-rated spec against the table named by ratingTableId, and still reports not_run without it', () => {
    const spec = { ...mixSpec(), rating: { system: 'EN 1092-1', pn: 16, ratingTableId: 'en-pn-test' } };
    const doc = apply(importedDoc(spec), 'import_rating_table', { table: enTable() });
    type Checked = { status: string; issues: Array<{ code: string; rule: string }>; design?: Json };
    const fine = data<Checked>(doc, 'check_pipe_spec', { specId: 'MIX-1', design: { pressureBar: 10, temperatureC: 70 } });
    expect(fine.design).toMatchObject({ checked: true, tableId: 'en-pn-test' });
    expect(fine.issues.map((issue) => issue.code)).toContain('PSC_DATA_UNVERIFIED');
    const over = data<Checked>(doc, 'check_pipe_spec', { specId: 'MIX-1', design: { pressureBar: 15.5, temperatureC: 70 } });
    expect(over.issues.map((issue) => issue.code)).toContain('PSC_PT_RATING_EXCEEDED');
    const missing = data<Checked>(importedDoc(spec), 'check_pipe_spec', { specId: 'MIX-1', design: { pressureBar: 10, temperatureC: 70 } });
    expect(missing.issues.find((issue) => issue.rule === 'design')).toMatchObject({ code: 'PSC_RATING_TABLE_UNKNOWN' });
    const byGroup = apply(
      importedDoc({ ...mixSpec(), rating: { system: 'EN 1092-1', pn: 16, materialGroup: 'test-1' } }),
      'import_rating_table',
      { table: enTable() },
    );
    expect(
      data<Checked>(byGroup, 'check_pipe_spec', { specId: 'MIX-1', design: { pressureBar: 10, temperatureC: 70 } }).design,
    ).toMatchObject({ checked: true });
  });

  it('list_piping_catalogs lists imported tables beside the bundled one', () => {
    const listed = data<{ ratingTables: Array<{ id: string; imported: boolean; classes: number[] }> }>(
      withTable,
      'list_piping_catalogs',
      {},
    );
    expect(listed.ratingTables.map((table) => [table.id, table.imported])).toEqual([
      ['asme-b16.5-group-1.1', false],
      ['en-pn-test', true],
    ]);
    expect(listed.ratingTables[1]?.classes).toEqual([16, 40]);
  });

  it('survives save and load, and a corrupt table is refused on load', () => {
    const loaded = deserializeDocument(serializeDocument(withTable));
    expect(loaded.plant?.catalog?.ratingTables).toEqual(withTable.plant?.catalog?.ratingTables);
    const good = JSON.parse(serializeDocument(withTable));
    good.document.plant.catalog.ratingTables['en-pn-test'].rows[0].bar.value = 'big';
    expect(() => deserializeDocument(JSON.stringify(good))).toThrow();
  });

  it('the load check names the problems of a rating-table slice', () => {
    const slice = (tables: unknown): string[] => pipingCatalogErrors({ catalogs: {}, catalogOrder: [], ratingTables: tables });
    const table = withTable.plant?.catalog?.ratingTables?.['en-pn-test'];
    expect(slice({ 'en-pn-test': table })).toEqual([]);
    expect(slice('x')).toEqual(['plant.catalog.ratingTables must be an object']);
    expect(slice({ other: table })[0]).toContain('must have id "other"');
    expect(slice({ 'asme-b16.5-group-1.1': { ...table, id: 'asme-b16.5-group-1.1' } })[0]).toContain('reserved');
    expect(slice({ a: { ...table, id: 'a' }, b: { ...table, id: 'b' } })[0]).toContain('repeats the standard');
    expect(slice({ 'en-pn-test': { ...table, rows: [] } })[0]).toContain('minTemperatureC and rows');
  });
});
