import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { pow } from '@lib/pow';

const FLOAT = new Float64Array(1);
const WORDS = new BigUint64Array(FLOAT.buffer);
const hexOf = (value: number): string => {
  FLOAT[0] = value;
  return (WORDS[0] as bigint).toString(16).padStart(16, '0');
};
const valueOf = (hex: string): number => {
  WORDS[0] = BigInt(`0x${hex}`);
  return FLOAT[0] as number;
};

/** x, y and Node 22's `Math.pow(x, y)` as bit patterns: specials, engineering ranges, the literal exponents of the code base, raw bit patterns, the overflow and subnormal edges. */
const reference = JSON.parse(readFileSync(new URL('./powReference.json', import.meta.url), 'utf8')) as { cases: string[] };

describe('pow (engine-independent power)', () => {
  it('reproduces the reference results bit for bit on this engine, whatever its own Math.pow does', () => {
    const wrong: string[] = [];
    for (const entry of reference.cases) {
      const [x, y, expected] = [valueOf(entry.slice(0, 16)), valueOf(entry.slice(16, 32)), valueOf(entry.slice(32, 48))];
      const actual = pow(x, y);
      const same = Number.isNaN(expected) ? Number.isNaN(actual) : hexOf(actual) === hexOf(expected);
      if (!same) wrong.push(`pow(${x}, ${y}) = ${actual}, expected ${expected}`);
    }
    expect(reference.cases.length).toBeGreaterThan(2500);
    expect(wrong.slice(0, 10)).toEqual([]);
  });

  it('follows the ECMAScript special cases', () => {
    expect(pow(7, 0)).toBe(1);
    expect(pow(Number.NaN, 0)).toBe(1);
    expect(pow(2, Number.NaN)).toBeNaN();
    expect(pow(1, Infinity)).toBeNaN();
    expect(pow(-8, 1 / 3)).toBeNaN();
    expect(pow(-2, 3)).toBe(-8);
    expect(pow(-2, 4)).toBe(16);
    expect(Object.is(pow(-0, 3), -0)).toBe(true);
    expect(pow(0, -1)).toBe(Infinity);
    expect(pow(2, 0.5)).toBe(Math.sqrt(2));
    expect(pow(3, 2)).toBe(9);
    expect(pow(2, 1024)).toBe(Infinity);
    expect(pow(2, -1080)).toBe(0);
    expect(pow(2, -1074)).toBe(Number.MIN_VALUE);
    expect(pow(10, 3)).toBe(1000);
  });
});
