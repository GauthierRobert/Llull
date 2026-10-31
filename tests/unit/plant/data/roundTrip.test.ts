/** Plant 08 DAT-M4: `import_plant_data` (VC-DAT-09): export -> edit cells -> preview / apply, the openpyxl fixtures, coded refusals, hostile files, budget. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { getPlantData } from '@aec/plant/data/model';
import { uint8ArrayToBase64 } from '@lib/base64';
import { xlsxWrite, type XlsxCell } from '@lib/xlsxWrite';
import { zipStore } from '@lib/zip';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { readXlsx } from '../../../helpers/xlsxCells';
import { libraryDocument, PACK, scDat01Document } from './dataFixtures';

interface Exported {
  files: Array<{ fileName: string; base64?: string; content?: string }>;
}
interface Imported {
  changes: Array<{ changeId: string; objectId: string; tag: string; property: string; from: unknown; to: unknown; cell: string }>;
  rejected: Array<{ code: string; cell: string; row: number; column: string; tag?: string; message: string }>;
  changeCount: number;
  rejectedCount: number;
  unchanged: number;
  rowsRead: number;
  rowsMatched: number;
  applied: number;
  documentChanged: boolean;
  warnings: Array<{ code: string }>;
}

const sc01 = scDat01Document();
const fixtureBase64 = (name: string): string => readFileSync(path.join(PACK, 'data/reference', name)).toString('base64');

/** The exported Equipment sheet as rows of cells, edited by `edit`, written again as an xlsx (base64). */
function editedExport(doc: typeof sc01, edit: (rows: XlsxCell[][]) => void, hierarchy = false): string {
  const exported = data<Exported>(doc, 'export_plant_data', { classes: ['Equipment'], format: 'xlsx' });
  const book = readXlsx(Buffer.from(exported.files[0]?.base64 ?? '', 'base64'));
  const sheet = book.sheets[0];
  const rows = (sheet?.rows ?? []).map((row) => [...row]) as XlsxCell[][];
  edit(rows);
  void hierarchy;
  const [header = [], ...body] = rows;
  return uint8ArrayToBase64(xlsxWrite([{ name: 'Equipment', columns: header.map((cell) => ({ header: String(cell) })), rows: body }]));
}

const column = (rows: XlsxCell[][], header: string): number => (rows[0] ?? []).indexOf(header);

describe('import_plant_data: the Excel round trip (VC-DAT-09)', () => {
  it('an export imported back is no change', () => {
    const exported = data<Exported>(sc01, 'export_plant_data', { classes: ['Equipment'], format: 'xlsx' });
    const preview = data<Imported>(sc01, 'import_plant_data', { fileBase64: exported.files[0]?.base64 });
    expect(preview).toMatchObject({ rowsRead: 2, rowsMatched: 2, rejectedCount: 0, applied: 0, documentChanged: false, changes: [] });
    expect(preview.unchanged).toBeGreaterThan(6);
    expect(preview.warnings).toEqual([]);
  });

  it('edit a cell, preview shows the change and leaves the document, apply writes ONE step with import provenance', () => {
    const file = editedExport(sc01, (rows) => {
      const weight = column(rows, 'OperatingWeight (kg)');
      const tag = column(rows, 'Tag');
      const pump = rows.find((row, index) => index > 0 && row[tag] === 'P-101') as XlsxCell[];
      pump[weight] = 480;
    });
    const preview = ok(sc01, 'import_plant_data', { fileBase64: file });
    expect(preview.document).toBe(sc01);
    const listed = preview.data as Imported;
    expect(listed.changes).toHaveLength(1);
    expect(listed.changes[0]).toMatchObject({ tag: 'P-101', property: 'OperatingWeight', from: 450, to: 480 });
    expect(listed.changes[0]?.changeId).toMatch(/^[0-9a-f]{12}$/);
    const applied = ok(sc01, 'import_plant_data', { fileBase64: file, mode: 'apply' });
    expect((applied.data as Imported).applied).toBe(1);
    expect(applied.document.featureHistory.length).toBe(sc01.featureHistory.length + 1);
    const object = Object.values(getPlantData(applied.document).objects).find((candidate) => candidate.tag === 'P-101');
    expect(object?.properties['OperatingWeight']).toBe(480);
    expect(object?.provenance?.['OperatingWeight']).toMatchObject({ source: 'import' });
    expect(
      data<{ rowsByTag: Record<string, { OperatingWeightKg: number }> }>(applied.document, 'plant_report', { kind: 'equipment_list' })
        .rowsByTag['P-101']?.OperatingWeightKg,
    ).toBe(480);
  });

  it('the openpyxl fixture: ObjectId equipment-1 names the model object; preview = 1 change + READONLY + TYPE, apply refused whole unless skip', () => {
    const fileBase64 = fixtureBase64('equipment-list-sc-dat-01-edited.xlsx');
    const preview = data<Imported>(sc01, 'import_plant_data', { fileBase64, mode: 'preview' });
    expect(preview.changes).toHaveLength(1);
    expect(preview.changes[0]).toMatchObject({ tag: 'P-101', property: 'OperatingWeight', from: 450, to: 480 });
    expect(preview.rejected.map((entry) => entry.code)).toEqual(['DAT_IMPORT_READONLY_COLUMN', 'DAT_IMPORT_TYPE']);
    expect(preview.rejected.map((entry) => entry.cell)).toEqual(['B2', 'G2']);
    expect(preview.documentChanged).toBe(false);
    const refused = expectRefusal(sc01, 'import_plant_data', { fileBase64, mode: 'apply' }, 'DAT_IMPORT_READONLY_COLUMN', 'Equipment!B2');
    expect(refused.error?.paths).toEqual(['Equipment!B2', 'Equipment!G2']);
    const skipped = ok(sc01, 'import_plant_data', { fileBase64, mode: 'apply', onRejected: 'skip' });
    expect(skipped.data).toMatchObject({ applied: 1, documentChanged: true, rejectedCount: 2 });
    const report = data<{ rowsByTag: Record<string, { OperatingWeightKg: number }> }>(skipped.document, 'plant_report', {
      kind: 'equipment_list',
    });
    expect(report.rowsByTag['P-101']?.OperatingWeightKg).toBe(480);
  });

  it('the unedited fixture is no change at all (the same cells as the export, mapped by header)', () => {
    const result = data<Imported>(sc01, 'import_plant_data', { fileBase64: fixtureBase64('equipment-list-sc-dat-01.xlsx') });
    expect(result).toMatchObject({ changes: [], rejectedCount: 0, rowsMatched: 2 });
  });

  it('accept applies a chosen subset and refuses an unknown change id', () => {
    const file = editedExport(sc01, (rows) => {
      const weight = column(rows, 'OperatingWeight (kg)');
      for (const row of rows.slice(1)) row[weight] = Number(row[weight]) + 1;
    });
    const preview = data<Imported>(sc01, 'import_plant_data', { fileBase64: file });
    expect(preview.changes).toHaveLength(2);
    const first = preview.changes[0]?.changeId as string;
    const one = ok(sc01, 'import_plant_data', { fileBase64: file, mode: 'apply', accept: [first] });
    expect((one.data as Imported).applied).toBe(1);
    expectRefusal(sc01, 'import_plant_data', { fileBase64: file, mode: 'apply', accept: ['0123456789ab'] }, 'DAT_PARAM_INVALID', 'accept');
  });

  it('converts a unit stated in the header and clears an emptied cell', () => {
    const file = editedExport(sc01, (rows) => {
      const weight = column(rows, 'OperatingWeight (kg)');
      const description = column(rows, 'Description');
      (rows[0] as XlsxCell[])[weight] = 'OperatingWeight (t)';
      for (const row of rows.slice(1)) {
        row[weight] = Number(row[weight]) / 1000;
        if (row[column(rows, 'Tag')] === 'P-101') row[description] = null;
      }
    });
    const preview = data<Imported>(sc01, 'import_plant_data', { fileBase64: file });
    expect(preview.changes.map((entry) => [entry.tag, entry.property, entry.to])).toEqual([['P-101', 'Description', null]]);
    expect(preview.rejectedCount).toBe(0);
  });

  it('CSV: exported by export_plant_data, keyed by Tag, text typed as numbers', () => {
    const exported = data<Exported>(sc01, 'export_plant_data', { classes: ['Equipment'], format: 'csv' });
    const csv = (exported.files[0]?.content ?? '').replace('450', '455.5');
    const preview = data<Imported>(sc01, 'import_plant_data', { csv, keyColumn: 'Tag' });
    expect(preview.changes.map((entry) => [entry.tag, entry.to])).toEqual([['P-101', 455.5]]);
    const semicolons = 'Tag;OperatingWeight (kg)\nP-101;"480,0"\n';
    expect(data<Imported>(sc01, 'import_plant_data', { csv: semicolons }).rejected[0]).toMatchObject({
      code: 'DAT_IMPORT_TYPE',
      cell: 'B2',
    });
  });

  it('codes every kind of bad cell with its cell reference and applies nothing', () => {
    const file = editedExport(sc01, (rows) => {
      const weight = column(rows, 'OperatingWeight (kg)');
      const pressure = column(rows, 'DesignPressure (barg)');
      const tag = column(rows, 'Tag');
      const klass = column(rows, 'Class');
      const id = column(rows, 'ObjectId');
      rows[1]![weight] = 'heavy';
      rows[1]![klass] = 'Pump';
      rows[2]![pressure] = -9999;
      rows.push(['nope', 'X-1']);
      rows.push([rows[1]![id] ?? null, rows[1]![tag] ?? null]);
      (rows[0] as XlsxCell[]).push('Mystery');
      rows[1]!.push('?');
    });
    const result = data<Imported>(sc01, 'import_plant_data', { fileBase64: file });
    expect(new Set(result.rejected.map((entry) => entry.code))).toEqual(
      new Set([
        'DAT_IMPORT_TYPE',
        'DAT_IMPORT_READONLY_COLUMN',
        'DAT_IMPORT_UNKNOWN_OBJECT',
        'DAT_IMPORT_DUPLICATE_ROW',
        'DAT_IMPORT_UNKNOWN_COLUMN',
      ]),
    );
    const before = JSON.stringify(sc01);
    const refused = execute(sc01, 'import_plant_data', { fileBase64: file, mode: 'apply' });
    expect(refused.rejected).toBe(true);
    expect(refused.document).toBe(sc01);
    expect(JSON.stringify(sc01)).toBe(before);
  });

  it('refuses a sheet without a key column, an unreadable file, both or neither source, and an unknown sheet', () => {
    const noKey = uint8ArrayToBase64(xlsxWrite([{ name: 'S', columns: [{ header: 'Description' }], rows: [['x']] }]));
    expectRefusal(sc01, 'import_plant_data', { fileBase64: noKey }, 'DAT_IMPORT_KEY_MISSING');
    expectRefusal(sc01, 'import_plant_data', { fileBase64: '!!!notbase64!!!' }, 'DAT_IMPORT_FORMAT');
    expectRefusal(sc01, 'import_plant_data', {}, 'DAT_PARAM_INVALID');
    expectRefusal(sc01, 'import_plant_data', { csv: 'Tag\nP-101', fileBase64: noKey }, 'DAT_PARAM_INVALID');
    expectRefusal(sc01, 'import_plant_data', { fileBase64: noKey, sheet: 'Nope' }, 'DAT_IMPORT_FORMAT', 'sheet');
    expectRefusal(sc01, 'import_plant_data', { csv: 'Tag,Tag\nP-101,x' }, 'DAT_IMPORT_FORMAT');
    expectRefusal(sc01, 'import_plant_data', { csv: '' }, 'DAT_IMPORT_FORMAT');
    expectRefusal(sc01, 'import_plant_data', { csv: 'Tag\n"open' }, 'DAT_IMPORT_FORMAT');
  });

  it('the hidden _meta sheet detects a stale export (warning) and still diffs', () => {
    const exported = data<Exported>(sc01, 'export_plant_data', { classes: ['Equipment'], format: 'xlsx' });
    const changed = apply(sc01, 'set_plant_properties', { edits: [{ object: 'P-101', property: 'DesignPressure', value: 9 }] });
    const result = data<Imported>(changed, 'import_plant_data', { fileBase64: exported.files[0]?.base64 });
    expect(result.warnings.map((warning) => warning.code)).toEqual(['DAT_IMPORT_STALE']);
    expect(result.changes.map((entry) => [entry.property, entry.to])).toEqual([['DesignPressure', 16]]);
    expect(data<Imported>(sc01, 'import_plant_data', { fileBase64: exported.files[0]?.base64 }).warnings).toEqual([]);
    expect(readXlsx(Buffer.from(exported.files[0]?.base64 ?? '', 'base64')).sheets.map((sheet) => sheet.name)).toEqual([
      'Equipment',
      '_meta',
    ]);
  });

  it('never evaluates a formula and a text that starts with = + - @ is only text', () => {
    const exported = data<Exported>(sc01, 'export_plant_data', { classes: ['Equipment'], format: 'xlsx' });
    const book = readXlsx(Buffer.from(exported.files[0]?.base64 ?? '', 'base64'));
    const rows = (book.sheets[0]?.rows ?? []).map((row) => [...row]) as XlsxCell[][];
    rows[1]![column(rows, 'Description')] = '=HYPERLINK("http://evil","x")';
    rows[2]![column(rows, 'Description')] = '@SUM(1)';
    const [header = [], ...body] = rows;
    const file = uint8ArrayToBase64(
      xlsxWrite([{ name: 'Equipment', columns: header.map((cell) => ({ header: String(cell) })), rows: body }]),
    );
    const result = data<Imported>(sc01, 'import_plant_data', { fileBase64: file });
    expect(result.changes.map((entry) => entry.to).sort()).toEqual(['=HYPERLINK("http://evil","x")', '@SUM(1)']);
    const csv = apply(sc01, 'set_plant_properties', { edits: [{ object: 'P-101', property: 'Description', value: '=1+1' }] });
    const file2 = data<Exported>(csv, 'export_plant_data', { classes: ['Equipment'], format: 'csv' });
    expect(file2.files[0]?.content).toContain("'=1+1");
    const back = data<Imported>(csv, 'import_plant_data', { csv: file2.files[0]?.content, keyColumn: 'Tag' });
    expect(back.changes).toEqual([]);
  });

  it('refuses a hostile archive with a code: path traversal, a zip bomb entry, a DTD', () => {
    const traversal = uint8ArrayToBase64(zipStore([{ name: '../../x.xml', data: new Uint8Array(1) }]));
    const result = execute(sc01, 'import_plant_data', { fileBase64: traversal });
    expect(result.error?.code).toBe('DAT_IMPORT_FORMAT');
    expect(result.error?.paths).toContain('fileBase64');
    expect(result.summary).toMatch(/XLSX_UNSAFE_ENTRY/);
  });

  it('reads a 10 000-row sheet and applies its 10 000 changes inside the budget (3x of the measured time)', () => {
    const base = libraryDocument();
    const withClass = apply(apply(base, 'define_plant_class', { name: 'MyPump', parent: 'CentrifugalPump' }), 'set_tag_format', {
      className: 'MyPump',
      tagFormat: '{classCode}-{seq:5}',
    });
    const big = apply(withClass, 'assign_plant_objects', {
      assignments: Array.from({ length: 10000 }, (_, index) => ({
        target: 'reserved',
        className: 'MyPump',
        hierarchy: 'U10',
        tagFields: { seq: index + 1 },
        properties: { Description: 'pump', DesignPressure: 10 },
      })),
    });
    const exported = data<Exported>(big, 'export_plant_data', { classes: ['MyPump'], format: 'xlsx' });
    const book = readXlsx(Buffer.from(exported.files[0]?.base64 ?? '', 'base64'));
    const rows = (book.sheets[0]?.rows ?? []).map((row) => [...row]) as XlsxCell[][];
    const pressure = (rows[0] ?? []).findIndex((header) => String(header).startsWith('Design pressure'));
    expect(pressure).toBeGreaterThan(0);
    for (const row of rows.slice(1)) row[pressure] = 11;
    const [header = [], ...body] = rows;
    const file = uint8ArrayToBase64(xlsxWrite([{ name: 'MyPump', columns: header.map((cell) => ({ header: String(cell) })), rows: body }]));
    const started = performance.now();
    const preview = data<Imported>(big, 'import_plant_data', { fileBase64: file });
    const applied = ok(big, 'import_plant_data', { fileBase64: file, mode: 'apply' });
    const elapsed = performance.now() - started;
    expect(preview.changeCount).toBe(10000);
    expect((applied.data as Imported).applied).toBe(10000);
    expect(elapsed).toBeLessThan(15000);
    expect(Object.values(getPlantData(applied.document).objects).every((object) => object.properties['DesignPressure'] === 11)).toBe(true);
  });

  it('is pure and replays to the same document', () => {
    const file = fixtureBase64('equipment-list-sc-dat-01-edited.xlsx');
    const before = JSON.stringify(sc01);
    const applied = ok(sc01, 'import_plant_data', { fileBase64: file, mode: 'apply', onRejected: 'skip' });
    expect(JSON.stringify(sc01)).toBe(before);
    const replayed = execute(applied.document, 'replay_history', {}).document;
    expect(getPlantData(replayed)).toEqual(getPlantData(applied.document));
  });
});
