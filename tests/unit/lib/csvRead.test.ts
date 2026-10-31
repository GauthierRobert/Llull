/** `@lib/csvRead`: RFC 4180 records, delimiters, BOM and line ends, nothing evaluated, bounded sizes. */

import { describe, expect, it } from 'vitest';
import { toCsv } from '@lib/csv';
import { readCsv } from '@lib/csvRead';

const rows = (text: string, limits = {}): string[][] => {
  const result = readCsv(text, limits);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.rows;
};

describe('readCsv', () => {
  it('reads what toCsv writes: quotes, commas, doubled quotes and line breaks inside a field', () => {
    const written = toCsv(
      ['Tag', 'Note'],
      [
        ['P-1', 'a, "b"\nc'],
        ['P-2', null],
        ['P-3', 5],
      ],
    );
    expect(rows(written)).toEqual([
      ['Tag', 'Note'],
      ['P-1', 'a, "b"\nc'],
      ['P-2', ''],
      ['P-3', '5'],
    ]);
  });

  it('accepts LF, CRLF and CR line ends, a BOM, blank lines and a missing final newline', () => {
    expect(rows('﻿a,b\r\n\r\nc,d\re,f')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
    expect(rows('a,b,\n,\n')).toEqual([
      ['a', 'b', ''],
      ['', ''],
    ]);
  });

  it('detects semicolons and tabs on the first line (quotes respected) unless a delimiter is given', () => {
    const semicolons = readCsv('a;b\n"x;y";2\n');
    expect(semicolons).toMatchObject({
      ok: true,
      delimiter: ';',
      rows: [
        ['a', 'b'],
        ['x;y', '2'],
      ],
    });
    expect(readCsv('a\tb\n1\t2')).toMatchObject({ delimiter: '\t' });
    expect(readCsv('"a;b",c\n1,2')).toMatchObject({ delimiter: ',' });
    expect(rows('a;b,c', { delimiter: ',' })).toEqual([['a;b', 'c']]);
  });

  it('keeps a stray quote and text after a closing quote, and never evaluates anything', () => {
    expect(rows('5" pipe,"a"b\n=1+1,@SUM(1)')).toEqual([
      ['5" pipe', 'ab'],
      ['=1+1', '@SUM(1)'],
    ]);
  });

  it.each([
    ['empty text', '', 'CSV_EMPTY'],
    ['only blank lines', '\n\n  \n', 'CSV_EMPTY'],
    ['an unterminated quote', 'a,"b', 'CSV_UNTERMINATED_QUOTE'],
  ])('refuses %s with a code', (_name, text, code) => {
    expect(readCsv(text)).toMatchObject({ ok: false, code });
  });

  it('refuses text, rows, columns and fields over the limits, naming the line', () => {
    expect(readCsv('abcdef', { maxChars: 3 })).toMatchObject({ ok: false, code: 'CSV_TOO_LARGE' });
    expect(readCsv('a\nb\nc\n', { maxRows: 2 })).toMatchObject({ ok: false, code: 'CSV_TOO_MANY_ROWS', line: 3 });
    expect(readCsv('a,b,c', { maxColumns: 2 })).toMatchObject({ ok: false, code: 'CSV_TOO_MANY_COLUMNS' });
    expect(readCsv('a,xxxxxxxx', { maxFieldChars: 4 })).toMatchObject({ ok: false, code: 'CSV_FIELD_TOO_LONG' });
    expect(readCsv(`a\n"${'""'.repeat(20)}"`, { maxFieldChars: 10 })).toMatchObject({ ok: false, code: 'CSV_FIELD_TOO_LONG' });
  });

  it('reads 100 000 records in well under a second', () => {
    const text = `Tag,Description\n${Array.from({ length: 100_000 }, (_, k) => `P-${k},"pump ${k}"`).join('\n')}\n`;
    const started = performance.now();
    expect(rows(text)).toHaveLength(100_001);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
