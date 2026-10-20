/** Part 21 values of the composite records: reals, string escapes and the \X2\ / \X4\ / \X\ / \S\ encodings. */

import { describe, expect, it } from 'vitest';
import { quoted, real, unquoted } from '@aero/composites/ap242/part21';
import { itemValue, numberList, referencesOutsideStrings, toNumber } from '@aero/composites/ap242/lex';

const roundTrip = (text: string): string => unquoted(quoted(text).slice(1, -1).replaceAll("''", "'"));

describe('Part 21 values', () => {
  it('writes reals the reader accepts and refuses a non-finite one', () => {
    expect(real(5)).toBe('5.');
    expect(real(0.25)).toBe('0.25');
    expect(real(1e-7)).toBe('1.E-7');
    expect(real(1.5e-7)).toBe('1.5E-7');
    expect(real(1e21)).toBe('1.E21');
    expect(real(-0)).toBe('0.');
    expect(() => real(Number.NaN)).toThrow(RangeError);
    expect(() => real(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('encodes quotes, backslashes, BMP characters as \\X2\\ and characters beyond it as \\X4\\, and decodes them back', () => {
    const text = "O'Brien \\ plié ✓";
    expect(quoted(text)).toBe("'O''Brien \\\\ pli\\X2\\00E9\\X0\\ \\X2\\2713\\X0\\'");
    expect(roundTrip(text)).toBe(text);
    expect(quoted('😀')).toBe("'\\X4\\0001F600\\X0\\'");
    for (const hostile of ['😀 #1 ', '\\X2\\0041\\X0\\ literal', "#'#", 'tab\tnew\nline', '\\\\', 'Tøøl 𝔘 \\'])
      expect(roundTrip(hostile)).toBe(hostile);
  });

  it('decodes the other encodings of the standard: \\X\\hh (ISO 8859-1), \\S\\c (high-bit character), a run of \\X2\\ units and a damaged escape kept literally', () => {
    expect(unquoted('caf\\X\\E9')).toBe('café');
    expect(unquoted('\\S\\i')).toBe('é');
    expect(unquoted('\\X2\\00410042\\X0\\')).toBe('AB');
    expect(unquoted('\\X4\\0001F600\\X0\\')).toBe('😀');
    expect(unquoted('\\X2\\00G1\\X0\\')).toBe('\\X2\\00G1\\X0\\');
    expect(unquoted('\\X2\\0041')).toBe('\\X2\\0041');
    expect(unquoted('\\X\\ZZ')).toBe('\\X\\ZZ');
    expect(unquoted('\\X4\\00110000\\X0\\')).toBe('\\X4\\00110000\\X0\\');
  });
});

describe('linear scanners', () => {
  it('reads references outside string literals only, numbers strictly, and survives garbage', () => {
    expect(referencesOutsideStrings("A('#12 it''s #3',#4,(#5,#6))")).toEqual([4, 5, 6]);
    expect(referencesOutsideStrings("A('unterminated #1")).toEqual([]);
    expect(referencesOutsideStrings('A(#,#x,#7)')).toEqual([7]);
    expect(toNumber('1.5E-3')).toBe(0.0015);
    expect(toNumber('abc')).toBeUndefined();
    expect(toNumber('9'.repeat(100))).toBeUndefined();
    expect(numberList("CARTESIAN_POINT('p (1,2)',(1.,2.5,-3E1))")).toEqual([1, 2.5, -30]);
    expect(numberList("CARTESIAN_POINT('p',(1.,x))")).toEqual([]);
    expect(numberList("CARTESIAN_POINT('p',(1,2,3,4,5,6,7))")).toEqual([]);
    expect(numberList("CARTESIAN_POINT('p'")).toEqual([]);
    expect(numberList("CARTESIAN_POINT('p',(1.,2.")).toEqual([]);
    expect(itemValue("MEASURE_REPRESENTATION_ITEM('a, b(1)',AREA_MEASURE(12.5),#7)")).toBe(12.5);
    expect(itemValue("INTEGER_REPRESENTATION_ITEM('n',3.)")).toBe(3);
    expect(itemValue("INTEGER_REPRESENTATION_ITEM('n',3.0,#1)")).toBe(3);
    expect(itemValue("VALUE_REPRESENTATION_ITEM('n',COUNT_MEASURE(4.))")).toBe(4);
    expect(itemValue("X('n',K(")).toBeUndefined();
    expect(itemValue('X')).toBeUndefined();
  });
});
