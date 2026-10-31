/** `@lib/xlsxWrite`: a valid SpreadsheetML package, deterministic bytes, escaping, sheet-name rules, limits, and the §8 budget (20 000 rows x 20 columns). */

import { describe, expect, it } from 'vitest';
import { xlsxColumnLetters, xlsxSheetName, xlsxWrite, type XlsxCell, type XlsxSheet } from '@lib/xlsxWrite';
import { readXlsx } from '../../helpers/xlsxCells';

const sheet = (overrides: Partial<XlsxSheet> = {}): XlsxSheet => ({
  name: 'Data',
  columns: [{ header: 'Tag' }, { header: 'Weight (kg)', locked: false }],
  rows: [
    ['P-101', 450],
    ['T <1> & "2"', null],
    ['', true],
  ],
  ...overrides,
});

describe('xlsxWrite', () => {
  it('writes every part of the package in a fixed order and reads back cell for cell', () => {
    const bytes = xlsxWrite([sheet(), sheet({ name: 'Other', protect: true })]);
    const book = readXlsx(bytes);
    expect([...book.files.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    expect(book.sheets.map((entry) => entry.name)).toEqual(['Data', 'Other']);
    expect(book.sheets[0]?.rows).toEqual([
      ['Tag', 'Weight (kg)'],
      ['P-101', 450],
      ['T <1> & "2"', null],
      [null, true],
    ]);
    expect([book.sheets[0]?.protectedSheet, book.sheets[1]?.protectedSheet]).toEqual([false, true]);
    expect(book.unlockedStyles).toEqual(new Set([1]));
    expect(book.sheets[0]?.styles.get('B2')).toBe(1);
    expect(book.sheets[0]?.styles.get('A2')).toBe(0);
  });

  it('gives equal bytes for equal input and different bytes for different input', () => {
    expect(Buffer.from(xlsxWrite([sheet()])).equals(Buffer.from(xlsxWrite([sheet()])))).toBe(true);
    expect(Buffer.from(xlsxWrite([sheet()])).equals(Buffer.from(xlsxWrite([sheet({ name: 'Data2' })])))).toBe(false);
  });

  it('drops characters XML cannot hold and non-finite numbers, keeps leading spaces', () => {
    const rows: XlsxCell[][] = [
      ['a\u0000b', Number.NaN],
      ['  padded', Infinity],
    ];
    const book = readXlsx(xlsxWrite([sheet({ rows })]));
    expect(book.sheets[0]?.rows[1]?.[0]).toBe('ab');
    expect(book.sheets[0]?.rows[2]?.[0]).toBe('  padded');
    expect(book.sheets[0]?.rows[1]?.[1] ?? null).toBeNull();
  });

  it('refuses a workbook without sheets, a bad or duplicate name, and a sheet over the Excel limits', () => {
    expect(() => xlsxWrite([])).toThrow(/at least one sheet/);
    expect(() => xlsxWrite([sheet({ name: '' })])).toThrow(/invalid/);
    expect(() => xlsxWrite([sheet({ name: 'a/b' })])).toThrow(/invalid/);
    expect(() => xlsxWrite([sheet({ name: 'x'.repeat(32) })])).toThrow(/invalid/);
    expect(() => xlsxWrite([sheet(), sheet({ name: 'DATA' })])).toThrow(/duplicate/);
    expect(() => xlsxWrite([sheet({ columns: Array.from({ length: 16385 }, () => ({ header: 'h' })), rows: [] })])).toThrow(/limit/);
    expect(() => xlsxWrite([sheet({ rows: new Array<XlsxCell[]>(1_048_576).fill([]) })])).toThrow(/limit/);
  });

  it('xlsxSheetName makes names valid and unique; xlsxColumnLetters counts like Excel', () => {
    expect(xlsxSheetName('a/b:c', [])).toBe('a_b_c');
    expect(xlsxSheetName('', [])).toBe('Sheet');
    expect(xlsxSheetName('Data', ['data', 'Data_2'])).toBe('Data_3');
    expect(xlsxSheetName('x'.repeat(40), [])).toHaveLength(31);
    expect(xlsxSheetName('x'.repeat(31), ['x'.repeat(31)])).toHaveLength(31);
    expect([0, 25, 26, 27, 701, 702, 16383].map(xlsxColumnLetters)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA', 'XFD']);
  });

  it('writes 20 000 rows x 20 columns under 3x the 3 s budget and 15 MB', () => {
    const columns = Array.from({ length: 20 }, (_, index) => ({ header: `Column ${index}`, locked: index < 4 }));
    const rows = Array.from({ length: 20000 }, (_, row) =>
      columns.map(
        (_column, index): XlsxCell => (index % 3 === 0 ? `value ${row} ${index}` : index % 3 === 1 ? row * 1.5 + index : row % 2 === 0),
      ),
    );
    const started = performance.now();
    const bytes = xlsxWrite([{ name: 'Big', columns, rows }]);
    const elapsed = performance.now() - started;
    expect(bytes.length).toBeLessThan(15 * 1024 * 1024);
    expect(elapsed).toBeLessThan(9000);
    expect(readXlsx(bytes).sheets[0]?.rows).toHaveLength(20001);
  });
});
