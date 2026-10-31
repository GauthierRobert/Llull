/** `@lib/xlsxRead`: reads what `xlsxWrite` and openpyxl wrote, formulas are values (never evaluated), and hostile archives are refused with a code. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deflateRaw } from '@lib/deflate';
import { readXlsx } from '@lib/xlsxRead';
import { xlsxWrite } from '@lib/xlsxWrite';
import { zipStore } from '@lib/zip';
import { deflatedZip } from '../../helpers/deflatedZip';
import { PACK } from '../plant/data/dataFixtures';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const WORKBOOK = `<workbook ${MAIN} ${REL}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;

/** A workbook with one sheet whose XML is `sheetData` and optional shared strings. */
function book(sheetData: string, shared?: string): Uint8Array {
  return zipStore([
    { name: 'xl/workbook.xml', data: text(WORKBOOK) },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: text('<Relationships xmlns="x"><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/></Relationships>'),
    },
    { name: 'xl/worksheets/sheet1.xml', data: text(`<worksheet ${MAIN}><sheetData>${sheetData}</sheetData></worksheet>`) },
    ...(shared === undefined ? [] : [{ name: 'xl/sharedStrings.xml', data: text(`<sst ${MAIN}>${shared}</sst>`) }]),
  ]);
}

const cells = (bytes: Uint8Array): unknown[][] => {
  const result = readXlsx(bytes);
  if (!result.ok) throw new Error(result.message);
  return (result.sheets[0]?.rows ?? []).map((row) => row.cells);
};

describe('readXlsx', () => {
  it('reads an xlsxWrite workbook: strings, numbers, booleans, holes, hidden sheets', () => {
    const bytes = xlsxWrite([
      {
        name: 'Data',
        columns: [{ header: 'Tag' }, { header: 'N' }, { header: 'B' }],
        rows: [
          ['P-1', 2.5, true],
          [null, 7, null],
        ],
      },
      { name: '_meta', columns: [{ header: 'k' }], rows: [['v']], hidden: true },
    ]);
    const result = readXlsx(bytes);
    expect(result.ok && result.sheets.map((sheet) => [sheet.name, sheet.hidden])).toEqual([
      ['Data', false],
      ['_meta', true],
    ]);
    expect(cells(bytes)).toEqual([
      ['Tag', 'N', 'B'],
      ['P-1', 2.5, true],
      [null, 7],
    ]);
  });

  it('reads the openpyxl fixtures (shared strings, a different column order than the writer)', () => {
    const fixture = readFileSync(path.join(PACK, 'data/reference/equipment-list-sc-dat-01-edited.xlsx'));
    const rows = cells(new Uint8Array(fixture));
    expect(rows[0]).toEqual(['ObjectId', 'Tag', 'Class', 'Description', 'Hierarchy', 'OperatingWeight (kg)', 'DesignPressure (barg)']);
    expect(rows[1]).toEqual(['equipment-1', 'T-102', 'Tank', 'Feed tank', 'S1/P1/U10', 2500, 'high']);
    expect(rows[2]?.[5]).toBe(480);
  });

  it('keeps text that looks like a formula as text and never evaluates a formula', () => {
    const rows = cells(
      book(
        '<row r="1"><c r="A1" t="inlineStr"><is><t>=1+1</t></is></c><c r="B1"><f>1+1</f><v>5</v></c><c r="C1"><f>SUM(A1)</f></c><c r="D1" t="e"><v>#REF!</v></c></row>',
      ),
    );
    expect(rows[0]).toEqual([
      '=1+1',
      5,
      { unreadable: 'formula', detail: '=SUM(A1) has no cached value (formulas are never evaluated)' },
      { unreadable: 'error', detail: '#REF!' },
    ]);
  });

  it('reads shared strings with rich-text runs and skips phonetic runs', () => {
    const rows = cells(
      book(
        '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c><c r="C2" t="s"><v>9</v></c><c r="D2" t="str"><v>x</v></c></row>',
        '<si><r><t>Hel</t></r><r><t>lo</t></r><rPh><t>ignored</t></rPh></si><si><t xml:space="preserve"> a </t></si>',
      ),
    );
    expect(rows[0]?.slice(0, 2)).toEqual(['Hello', ' a ']);
    expect(rows[0]?.[2]).toMatchObject({ unreadable: 'error' });
    expect(rows[0]?.[3]).toBe('x');
  });

  it('flags non-numeric numbers and over-long strings instead of passing them on', () => {
    const rows = cells(
      book(
        `<row r="1"><c r="A1"><v>abc</v></c><c r="B1" t="inlineStr"><is><t>${'x'.repeat(40_000)}</t></is></c><c r="C1" t="b"><v>0</v></c><c r="D1"><v/></c></row>`,
      ),
    );
    expect(rows[0]?.[0]).toMatchObject({ unreadable: 'error' });
    expect(rows[0]?.[1]).toMatchObject({ unreadable: 'text' });
    expect(rows[0]?.[2]).toBe(false);
  });

  it.each([
    ['not a zip', new Uint8Array([1, 2, 3]), 'XLSX_ZIP'],
    ['an empty file', new Uint8Array(), 'XLSX_ZIP'],
    ['a zip without a workbook', zipStore([{ name: 'a.txt', data: text('x') }]), 'XLSX_STRUCTURE'],
    ['a traversal entry name', zipStore([{ name: '../evil.xml', data: text('x') }]), 'XLSX_UNSAFE_ENTRY'],
    ['an absolute entry name', zipStore([{ name: '/etc/passwd', data: text('x') }]), 'XLSX_UNSAFE_ENTRY'],
    ['a backslash entry name', zipStore([{ name: 'a\\b', data: text('x') }]), 'XLSX_UNSAFE_ENTRY'],
    ['a very long entry name', zipStore([{ name: 'a'.repeat(300), data: text('x') }]), 'XLSX_UNSAFE_ENTRY'],
    ['a malformed workbook xml', zipStore([{ name: 'xl/workbook.xml', data: text('<workbook><sheets>') }]), 'XLSX_XML'],
    ['a DTD in the workbook', zipStore([{ name: 'xl/workbook.xml', data: text('<!DOCTYPE x [<!ENTITY a "b">]><workbook/>') }]), 'XLSX_XML'],
  ])('refuses %s', (_name, bytes, code) => {
    const result = readXlsx(bytes);
    expect(result.ok ? 'ok' : result.code).toBe(code);
  });

  it('refuses a relationship target that leaves the package', () => {
    const bytes = zipStore([
      { name: 'xl/workbook.xml', data: text(WORKBOOK) },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: text('<Relationships><Relationship Id="rId1" Target="../../../etc/x.xml"/></Relationships>'),
      },
    ]);
    const result = readXlsx(bytes);
    expect(result.ok ? 'ok' : result.code).toBe('XLSX_UNSAFE_ENTRY');
  });

  it('refuses too many entries, rows or columns beyond the limit, rows out of order and too many cells', () => {
    const many = zipStore(Array.from({ length: 20 }, (_, k) => ({ name: `f${k}.txt`, data: text('x') })));
    expect(readXlsx(many, { maxEntries: 10 })).toMatchObject({ ok: false, code: 'XLSX_TOO_LARGE' });
    expect(readXlsx(book('<row r="2000000"><c r="A2000000"><v>1</v></c></row>'))).toMatchObject({ ok: false, code: 'XLSX_STRUCTURE' });
    expect(readXlsx(book('<row r="1"><c r="XFD1"><v>1</v></c></row>'))).toMatchObject({ ok: false, code: 'XLSX_STRUCTURE' });
    expect(readXlsx(book('<row r="3"><c r="A3"><v>1</v></c></row><row r="2"><c r="A2"><v>1</v></c></row>'))).toMatchObject({
      ok: false,
      code: 'XLSX_STRUCTURE',
    });
    expect(readXlsx(book('<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>1</v></c></row>'), { maxCells: 1 })).toMatchObject({
      ok: false,
      code: 'XLSX_TOO_LARGE',
    });
    expect(readXlsx(new Uint8Array(100), { maxFileBytes: 10 })).toMatchObject({ ok: false, code: 'XLSX_TOO_LARGE' });
  });

  it('stops a zip bomb at the inflate cap, without inflating the other entries', () => {
    const zeros = new Uint8Array(60 << 20);
    const packed = deflateRaw(zeros);
    expect(packed.length).toBeLessThan(500_000);
    const bomb = (name: string, limit?: number): ReturnType<typeof readXlsx> =>
      readXlsx(deflatedZip([{ name, data: zeros, packed }]), limit === undefined ? {} : { maxInflatedBytes: limit });
    expect(bomb('xl/worksheets/sheet1.xml', 1 << 20)).toMatchObject({ ok: false, code: 'XLSX_TOO_LARGE' });
    expect(bomb('xl/sharedStrings.xml')).toMatchObject({ ok: false, code: 'XLSX_TOO_LARGE' });
    expect(bomb('docProps/huge.bin')).toMatchObject({ ok: false, code: 'XLSX_STRUCTURE' });
  });
});
