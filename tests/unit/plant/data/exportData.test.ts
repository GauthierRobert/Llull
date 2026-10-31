/** Plant 08 DAT-M2: `export_plant_data` (VC-DAT-09 export half): sheets per class, locked columns, CSV, determinism, refusals. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { readXlsx, type Cell } from '../../../helpers/xlsxCells';
import type { CadDocument } from '@core/model/types';
import { boxOf, step } from '../../materials/support';
import { PACK, scDat01Document } from './dataFixtures';

interface Exported {
  files: Array<{ fileName: string; base64?: string; content?: string }>;
  sheets: Record<string, { rows: number; columns: string[] }>;
}

const sc01 = scDat01Document();
const bytesOf = (file: { base64?: string } | undefined): Buffer => Buffer.from(file?.base64 ?? '', 'base64');
const fixture = (name: string): Buffer => readFileSync(path.join(PACK, 'data/reference', name));

/** Cells by header, one record per row. */
const records = (rows: Cell[][]): Array<Record<string, Cell>> =>
  rows.slice(1).map((row) => Object.fromEntries((rows[0] ?? []).map((header, index) => [String(header), row[index] ?? null])));

describe('export_plant_data', () => {
  it('writes the equipment sheet with the cells of the pack fixture (VC-DAT-09), ObjectId aside', () => {
    const result = data<Exported>(sc01, 'export_plant_data', { classes: ['Equipment'], format: 'xlsx' });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.fileName).toBe('plant-data.xlsx');
    expect(result.sheets['Equipment']?.rows).toBe(2);
    const mine = readXlsx(bytesOf(result.files[0]));
    const theirs = readXlsx(fixture('equipment-list-sc-dat-01.xlsx'));
    // the hidden _meta sheet (plant data hash, DAT-M4) is the only addition
    expect(mine.sheets.map((sheet) => sheet.name)).toEqual([...theirs.sheets.map((sheet) => sheet.name), '_meta']);
    const strip = (row: Record<string, Cell>): Record<string, Cell> =>
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'ObjectId'));
    const ours = records(mine.sheets[0]?.rows ?? []).map(strip);
    const reference = records(theirs.sheets[0]?.rows ?? []).map(strip);
    expect(Object.keys(ours[0] ?? {}).sort()).toEqual(Object.keys(reference[0] ?? {}).sort());
    const byTag = (rows: Array<Record<string, Cell>>): Array<Record<string, Cell>> =>
      [...rows].sort((a, b) => String(a['Tag']).localeCompare(String(b['Tag'])));
    expect(ours.map((row) => row['Tag'])).toEqual(['P-101', 'T-101']);
    expect(byTag(ours)).toEqual(byTag(reference));
    expect(records(mine.sheets[0]?.rows ?? []).map((row) => String(row['ObjectId']))).toEqual([
      expect.stringMatching(/^plantobj-\d+\.\d+$/),
      expect.stringMatching(/^plantobj-\d+\.\d+$/),
    ]);
  });

  it('locks ObjectId, Tag, Class and Hierarchy and unlocks the editable properties, like the fixture', () => {
    const result = data<Exported>(sc01, 'export_plant_data', { classes: ['Equipment'] });
    const book = readXlsx(bytesOf(result.files[0]));
    const sheet = book.sheets[0];
    expect(sheet?.protectedSheet).toBe(true);
    const header = (sheet?.rows[0] ?? []).map(String);
    const unlocked = (column: string): boolean =>
      book.unlockedStyles.has(sheet?.styles.get(`${String.fromCharCode(65 + header.indexOf(column))}2`) ?? 0);
    for (const locked of ['ObjectId', 'Tag', 'Class', 'Hierarchy']) expect(unlocked(locked), locked).toBe(false);
    for (const editable of ['Description', 'OperatingWeight (kg)', 'DesignPressure (barg)'])
      expect(unlocked(editable), editable).toBe(true);
    const fixtureBook = readXlsx(fixture('equipment-list-sc-dat-01.xlsx'));
    expect(fixtureBook.sheets[0]?.protectedSheet).toBe(true);
  });

  it('one sheet per class, subclasses included, only the objects of the hierarchy node', () => {
    const outside = apply(sc01, 'define_plant_hierarchy', { nodes: [{ code: 'U20', kind: 'unit', parent: 'P1' }] });
    const result = data<Exported>(outside, 'export_plant_data', { classes: ['Tank', 'ProcessLine', 'Tank'], hierarchy: 'U10' });
    expect(Object.keys(result.sheets)).toEqual(['Tank', 'ProcessLine']);
    expect(result.sheets['Tank']?.rows).toBe(1);
    expect(result.sheets['ProcessLine']?.rows).toBe(2);
    expect(readXlsx(bytesOf(result.files[0])).sheets.map((sheet) => sheet.name)).toEqual(['Tank', 'ProcessLine', '_meta']);
    expect(data<Exported>(outside, 'export_plant_data', { classes: ['Tank'], hierarchy: 'U20' }).sheets['Tank']?.rows).toBe(0);
  });

  it('csv: one file per class with "Name (unit)" headers; includeReadOnly false keeps ObjectId and the editable columns', () => {
    const result = data<Exported>(sc01, 'export_plant_data', { classes: ['Equipment', 'ProcessLine'], format: 'csv' });
    expect(result.files.map((file) => file.fileName)).toEqual(['Equipment.csv', 'ProcessLine.csv']);
    const lines = (result.files[0]?.content ?? '').trimEnd().split('\n');
    expect(lines[0]).toBe('ObjectId,Tag,Class,Hierarchy,Description,OperatingWeight (kg),DesignPressure (barg)');
    expect(lines[1]).toMatch(/^plantobj-\d+\.\d+,P-101,CentrifugalPump,S1\/P1\/U10,Transfer pump,450,16$/);
    const editable = data<Exported>(sc01, 'export_plant_data', { classes: ['Equipment'], includeReadOnly: false, format: 'csv' });
    expect((editable.files[0]?.content ?? '').split('\n')[0]).toBe('ObjectId,Description,OperatingWeight (kg),DesignPressure (barg)');
  });

  it('is pure and byte-identical on repeat; a rebuild by replay exports the same bytes', () => {
    const before = JSON.stringify(sc01);
    const first = execute(sc01, 'export_plant_data', { classes: ['Equipment', 'ProcessLine'] });
    expect(first.document).toBe(sc01);
    expect(first.affected).toEqual([]);
    expect(JSON.stringify(sc01)).toBe(before);
    const again = execute(sc01, 'export_plant_data', { classes: ['Equipment', 'ProcessLine'] });
    expect(again.data).toEqual(first.data);
    const replayed = execute(sc01, 'replay_history', {}).document;
    expect(execute(replayed, 'export_plant_data', { classes: ['Equipment', 'ProcessLine'] }).data).toEqual(first.data);
  });

  it('refuses an unknown class or hierarchy node, and bad parameters, leaving the document unchanged', () => {
    expectRefusal(sc01, 'export_plant_data', { classes: ['Equipment', 'Nope'] }, 'DAT_CLASS_UNKNOWN', 'classes');
    expectRefusal(sc01, 'export_plant_data', { classes: ['Equipment'], hierarchy: 'U99' }, 'DAT_HIERARCHY_UNKNOWN', 'hierarchy');
    expectRefusal(sc01, 'export_plant_data', { classes: [] }, 'DAT_PARAM_INVALID', 'classes');
    for (const params of [{}, { classes: ['Equipment'], format: 'ods' }, { classes: [1] }]) {
      const result = execute(sc01, 'export_plant_data', params);
      expect(result.rejected, JSON.stringify(params)).toBe(true);
      expect(result.document).toBe(sc01);
    }
  });
});

describe('the export gate (TR-MAT-30 / 51)', () => {
  const record = { id: 'secret', designation: 'X', specs: [], licence: 'company-proprietary', exportMarking: { regime: 'ITAR' } };
  const controlled = (): CadDocument => boxOf(step(sc01, 'define_material_record', record), 'secret').doc;

  it('export_plant_data and the csv / xlsx of plant_report refuse a controlled document; json reports and the agent flag stay as they are', () => {
    const doc = controlled();
    expectRefusal(doc, 'export_plant_data', { classes: ['Equipment'] }, 'MAT_EXPORT_CONTROLLED');
    expectRefusal(doc, 'export_plant_data', { classes: ['Equipment'], confirmExportControlled: true }, 'MAT_HUMAN_GATE');
    expectRefusal(doc, 'plant_report', { kind: 'tag_register', format: 'csv' }, 'MAT_EXPORT_CONTROLLED');
    expectRefusal(doc, 'plant_report', { kind: 'tag_register', format: 'xlsx' }, 'MAT_EXPORT_CONTROLLED');
    expect(execute(doc, 'plant_report', { kind: 'tag_register' }).rejected).toBeUndefined();
  });
});
