import { describe, it, expect } from 'vitest';
import { optionalNumber, parseNumber, parseNumberList, parseNumberRow } from '@ui/numberText';
import { FieldReader } from '@ui/panels/building/elementToolForm';

describe('numberText', () => {
  it('parses finite numbers and rejects blank / invalid text', () => {
    expect(parseNumber(' 2.5 ')).toBe(2.5);
    expect(parseNumber('')).toBeUndefined();
    expect(parseNumber('abc')).toBeUndefined();
    expect(parseNumber('Infinity')).toBeUndefined();
  });

  it('builds an optional param only for a number', () => {
    expect(optionalNumber('height', '3')).toEqual({ height: 3 });
    expect(optionalNumber('height', ' ')).toEqual({});
    expect(optionalNumber('height', 'x')).toEqual({});
  });

  it('splits rows and lists on commas, semicolons and spaces', () => {
    expect(parseNumberRow('1, 2 3')).toEqual([1, 2, 3]);
    expect(parseNumberRow('1, a')).toBeNull();
    expect(parseNumberList('1; 2, 3')).toEqual([1, 2, 3]);
    expect(parseNumberList('  ')).toEqual([]);
  });
});

describe('FieldReader numbers', () => {
  it('records blank or invalid required numbers as missing', () => {
    const reader = new FieldReader({ a: '4', b: '', c: 'x', d: '', e: 'y', list: '1;2' });
    expect(reader.number('a')).toBe(4);
    reader.number('b');
    reader.number('c');
    expect(reader.optionalNumber('d')).toBeUndefined();
    reader.optionalNumber('e');
    expect(reader.numberList('list')).toEqual([1, 2]);
    reader.numberList('d');
    expect(reader.missing).toEqual(['b', 'c', 'e', 'd']);
  });
});
