/** Plant 01 PSC M4: the CSV sheets (spec sheet, branch table, catalogue sheet) from untrusted files: formula injection is neutralised, RFC 4180 round trip holds. */

import { describe, expect, it } from 'vitest';
import { readCsv } from '@lib/csvRead';
import { guardCell } from '@aec/plant/catalog/csvGuard';
import { createEmptyDocument } from '@core/model/types';
import { apply, data } from '../../../helpers/commandAssertions';
import { importedDoc } from './specFixture';

type Exported = { text: string; branchCsv?: string };
const hostile = ['=HYPERLINK("http://evil.example","x")', '+1+2', '-2+3', '@SUM(A1)', '\tTAB', '\rCR'];

const sheetRows = (text: string): string[][] => {
  const parsed = readCsv(text);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.rows;
};

describe('CSV sheets from untrusted data', () => {
  it('prefixes a text cell that could start a formula with an apostrophe and leaves everything else alone', () => {
    for (const cell of hostile) expect(guardCell(cell)).toBe(`'${cell}`);
    expect(guardCell('NPS 2')).toBe('NPS 2');
    expect(guardCell('a=b')).toBe('a=b');
    expect(guardCell(-5)).toBe(-5);
    expect(guardCell(true)).toBe(true);
    expect(guardCell(null)).toBeNull();
    expect(guardCell('')).toBe('');
  });

  it('exports a spec whose description, commodity code and material are hostile with each guarded, and the rows still parse as RFC 4180', () => {
    const doc = importedDoc();
    const edited = apply(doc, 'edit_pipe_spec', {
      specId: 'CS150-A1',
      ops: [
        {
          op: 'updateComponent',
          id: 'E90-LR',
          changes: { description: '=HYPERLINK("http://evil.example","click, here")', commodityCode: '@SUM(A1)', material: '-2+3' },
        },
      ],
    });
    const { text } = data<Exported>(edited, 'export_pipe_spec', { specId: 'CS150-A1', format: 'csv' });
    const rows = sheetRows(text);
    const header = rows[0] as string[];
    const row = rows.find((candidate) => candidate[0] === 'E90-LR') as string[];
    expect(row[header.indexOf('description')]).toBe(`'=HYPERLINK("http://evil.example","click, here")`);
    expect(row[header.indexOf('commodityCode')]).toBe("'@SUM(A1)");
    expect(row[header.indexOf('material')]).toBe("'-2+3");
    expect(rows.every((candidate) => candidate.length === header.length)).toBe(true);
    for (const candidate of rows.flat()) expect(candidate).not.toMatch(/^[=+\-@\t\r]/);
  });

  it('does not touch numbers: class, pn and wall stay plain numeric text', () => {
    const { text } = data<Exported>(importedDoc(), 'export_pipe_spec', { specId: 'CS150-A1', format: 'csv' });
    const rows = sheetRows(text);
    const header = rows[0] as string[];
    const flange = rows.find((candidate) => candidate[0] === 'F-WN') as string[];
    expect(flange[header.indexOf('class')]).toBe('150');
    expect(flange[header.indexOf('from')]).toBe('NPS 2');
  });

  it('guards the catalogue sheet too: a standard or family text that starts like a formula', () => {
    const doc = apply(createEmptyDocument(), 'import_piping_catalog', {
      catalog: {
        format: 'llull-piping-catalog',
        schemaVersion: 1,
        id: 'evil',
        licence: 'open-data',
        families: [
          {
            id: '-evil-fam',
            type: 'elbow90',
            standard: '=cmd|"/c calc"!A1',
            radius: 'LR',
            sizes: [{ nps: 4, centreToEnd: 152.4, provenance: { citation: 't' } }],
          },
        ],
      },
    });
    const { text } = data<Exported>(doc, 'export_piping_catalog', { catalogId: 'evil', format: 'csv' });
    const row = sheetRows(text)[1] as string[];
    expect(row[0]).toBe("'-evil-fam");
    expect(row[2]).toBe(`'=cmd|"/c calc"!A1`);
    expect(row[3]).toBe('NPS 4');
  });
});
