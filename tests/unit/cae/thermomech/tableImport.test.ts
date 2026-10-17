/** fea_import_field CSV parsing (PHY-04 TR-TMC-14): x,y,z,T rows with declared units. */
import { describe, expect, it } from 'vitest';
import { MAX_TABLE_ROWS, parseFieldTable } from '@cae/thermomech/tableImport';

describe('parseFieldTable', () => {
  it('reads comma, semicolon, tab and space separated rows with an optional header, comments and blank lines', () => {
    const csv = ['x,y,z,T', '# a comment', '', '0,0,0,20', '1;2;3;21.5', '4\t5\t6\t22', '7 8 9 1e1', '  10 , 11 , 12 , -5.5E0 ,'].join(
      '\r\n',
    );
    const parsed = parseFieldTable(csv, 'mm', 'degC');
    expect(parsed).toMatchObject({ ok: true, rows: 5, minT: -5.5, maxT: 22 });
    expect(parsed.ok && parsed.artifact).toEqual({
      kind: 'fe_table',
      rows: [
        [0, 0, 0, 20],
        [1, 2, 3, 21.5],
        [4, 5, 6, 22],
        [7, 8, 9, 10],
        [10, 11, 12, -5.5],
      ],
    });
  });

  it('accepts a header in any case and rows without one', () => {
    expect(parseFieldTable('X,Y,Z,Temp\n1,2,3,4', 'm', 'K')).toMatchObject({ ok: true, rows: 1 });
    expect(parseFieldTable('1,2,3,4', 'in', 'degF')).toMatchObject({ ok: true, rows: 1 });
  });

  it('refuses bad units, empty tables, malformed rows, non-numbers and implausible temperatures with the line number', () => {
    expect(parseFieldTable('1,2,3,4', 'furlong', 'K')).toMatchObject({ ok: false, code: 'TMC_FIELD_SOURCE_INVALID' });
    expect(parseFieldTable('1,2,3,4', 'mm', 'W')).toMatchObject({ ok: false, code: 'TMC_FIELD_SOURCE_INVALID' });
    expect(parseFieldTable('x,y,z,T\n# nothing\n', 'mm', 'K')).toMatchObject({ ok: false, code: 'TMC_FIELD_SOURCE_INVALID' });
    const short = parseFieldTable('1,2,3,4\n1,2,3', 'mm', 'K');
    expect(short).toMatchObject({ ok: false, code: 'TMC_FIELD_INVALID' });
    expect(!short.ok && short.message).toContain('line 2');
    expect(parseFieldTable('a,b,c,d\n1,2,3,4', 'mm', 'K')).toMatchObject({ ok: false, code: 'TMC_FIELD_INVALID' });
    expect(parseFieldTable('1,2,3,hot', 'mm', 'K')).toMatchObject({ ok: false, code: 'TMC_FIELD_INVALID' });
    expect(parseFieldTable('1,2,3,NaN', 'mm', 'K')).toMatchObject({ ok: false, code: 'TMC_FIELD_INVALID' });
    expect(parseFieldTable('1,2,3,-1', 'mm', 'K')).toMatchObject({ ok: false, code: 'TMC_FIELD_INVALID' });
    expect(parseFieldTable('1,2,3,-300', 'mm', 'degC')).toMatchObject({ ok: false, code: 'TMC_FIELD_INVALID' });
    expect(parseFieldTable('1,2,3,2e5', 'mm', 'K')).toMatchObject({ ok: false, code: 'TMC_FIELD_INVALID' });
  });

  it('names its row guard', () => {
    expect(MAX_TABLE_ROWS).toMatchObject({ value: 5_000_000, source: 'llull guard' });
  });
});
