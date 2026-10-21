/** Shared leaf helpers consolidated from per-package copies: csv, interp1, nextFreeId, specialFunctions, step21/encode, normalize3OrZero, round6. */

import { describe, expect, it } from 'vitest';
import { round6 } from '@lib/compactNumber';
import { csvCell, csvLines, toCsv } from '@lib/csv';
import { nextFreeId } from '@lib/id';
import { interp1, interp1Pairs } from '@lib/interp1';
import { erf, erfc, normalCdf } from '@lib/specialFunctions';
import { encodeStepString, quoteStepString, stepReal } from '@lib/step21/encode';
import { unescapeStep } from '@lib/step21/decode';
import { normalize3OrZero } from '@lib/vec3';

describe('csv', () => {
  it('quotes cells with comma, quote or line break and writes null as empty', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(1.5)).toBe('1.5');
    expect(csvCell(false)).toBe('false');
  });
  it('joins records with \\n and terminates with toCsv', () => {
    expect(csvLines(['a', 'b'], [[1, 'x,y']])).toBe('a,b\n1,"x,y"');
    expect(toCsv(['a'], [[1], [2]])).toBe('a\n1\n2\n');
  });
});

describe('interp1', () => {
  it('interpolates, holds the ends and returns `empty` without knots', () => {
    expect(interp1([0, 1, 3], [0, 10, 30], 0.5)).toBe(5);
    expect(interp1([0, 1, 3], [0, 10, 30], 2)).toBe(20);
    expect(interp1([0, 1, 3], [0, 10, 30], -5)).toBe(0);
    expect(interp1([0, 1, 3], [0, 10, 30], 9)).toBe(30);
    expect(interp1([0, 1, 3], [0, 10, 30], 1)).toBe(10);
    expect(interp1([], [], 1)).toBe(0);
    expect(interp1([], [], 1, Number.NaN)).toBeNaN();
  });
  it('reads [x, y] pairs identically', () => {
    const points: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [1, 10],
      [3, 30],
    ];
    expect(interp1Pairs(points, 2)).toBe(20);
    expect(interp1Pairs(points, 4)).toBe(30);
    expect(interp1Pairs([], 4, 7)).toBe(7);
  });
});

describe('nextFreeId', () => {
  it('skips taken ids, pads and honours separator and start', () => {
    const taken = new Set(['BL-0001', 'BL-0002']);
    expect(nextFreeId('BL', (id) => taken.has(id), { pad: 4 })).toBe('BL-0003');
    expect(nextFreeId('BL', (id) => taken.has(id), { pad: 4, start: 2 })).toBe('BL-0003');
    expect(nextFreeId('f', (id) => id === 'f1', { sep: '' })).toBe('f2');
    expect(nextFreeId('x', () => false)).toBe('x-1');
  });
});

describe('specialFunctions', () => {
  it('erf, erfc and normalCdf match known values', () => {
    expect(erf(0)).toBe(0);
    expect(erf(1)).toBeCloseTo(0.8427007929497149, 12);
    expect(erf(-1)).toBeCloseTo(-0.8427007929497149, 12);
    expect(erf(7)).toBe(1);
    expect(erf(-7)).toBe(-1);
    expect(erf(Number.NaN)).toBeNaN();
    expect(erfc(0.5)).toBeCloseTo(0.4795001221869535, 12);
    expect(erfc(-0.5)).toBeCloseTo(1.5204998778130465, 12);
    expect(erfc(3)).toBeCloseTo(2.209049699858544e-5, 15);
    expect(normalCdf(0)).toBe(0.5);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021048517795, 12);
  });
});

describe('step21 encode', () => {
  it('doubles quotes and backslashes and escapes non-ASCII per character', () => {
    expect(quoteStepString("it's a\\b")).toBe("'it''s a\\\\b'");
    expect(encodeStepString('é')).toBe('\\X2\\00E9\\X0\\');
    expect(encodeStepString('😀')).toBe('\\X4\\0001F600\\X0\\');
    expect(encodeStepString('a\tb')).toBe('a\\X2\\0009\\X0\\b');
    expect(unescapeStep(encodeStepString('é😀x'))).toBe('é😀x');
  });
  it('groups a non-ASCII run into one X2 of UTF-16 units when asked', () => {
    expect(encodeStepString('éa😀', true)).toBe('\\X2\\00E9\\X0\\a\\X2\\D83DDE00\\X0\\');
    expect(encodeStepString("a'b", true)).toBe("a''b");
  });
  it('writes REALs with a decimal point and rejects or zeroes non-finite values', () => {
    expect(stepReal(5)).toBe('5.');
    expect(stepReal(0.25)).toBe('0.25');
    expect(stepReal(1e-7)).toBe('1.E-7');
    expect(stepReal(-0)).toBe('0.');
    expect(() => stepReal(Number.NaN)).toThrow(RangeError);
    expect(stepReal(Number.POSITIVE_INFINITY, 'zero')).toBe('0.');
  });
});

describe('vec3 / compactNumber additions', () => {
  it('normalize3OrZero keeps the zero vector and normalises others', () => {
    expect(normalize3OrZero([0, 0, 0])).toEqual([0, 0, 0]);
    expect(normalize3OrZero([0, 3, 4])).toEqual([0, 0.6, 0.8]);
  });
  it('round6 rounds to micro-units', () => {
    expect(round6(1.23456789)).toBe(1.234568);
    expect(round6(-2.5e-7)).toBe(-0);
  });
});
