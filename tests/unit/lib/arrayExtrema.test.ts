import { describe, expect, it } from 'vitest';
import { maxOf, minOf } from '@lib/arrayExtrema';

/** Deterministic corpus: special values mixed with LCG draws over many magnitudes and both signs. */
function corpus(): number[][] {
  const specials = [0, -0, 1, -1, NaN, Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE];
  const lists: number[][] = [[], [NaN], [0], [-0], [0, -0], [-0, 0], [-0, -0], [-Infinity], [Infinity], [-0, NaN, 0], [NaN, Infinity]];
  let state = 12345;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  for (let list = 0; list < 400; list++) {
    const length = Math.floor(next() * 12);
    const values: number[] = [];
    for (let i = 0; i < length; i++) {
      const pick = next();
      if (pick < 0.15) values.push(specials[Math.floor(next() * specials.length)] as number);
      else values.push((next() - 0.5) * 10 ** Math.floor(next() * 20 - 10));
    }
    lists.push(values);
  }
  return lists;
}

describe('maxOf / minOf', () => {
  it('equal Math.max / Math.min of the spread on every corpus list, incl. empty, NaN and the sign of zero', () => {
    for (const values of corpus()) {
      expect(Object.is(maxOf(values), Math.max(...values)), `max ${values.join(',')}`).toBe(true);
      expect(Object.is(minOf(values), Math.min(...values)), `min ${values.join(',')}`).toBe(true);
    }
  });

  it('pins the edge semantics', () => {
    expect(maxOf([])).toBe(-Infinity);
    expect(minOf([])).toBe(Infinity);
    expect(maxOf([1, NaN, 2])).toBeNaN();
    expect(minOf([NaN, -Infinity])).toBeNaN();
    expect(Object.is(maxOf([-0, 0]), 0)).toBe(true);
    expect(Object.is(maxOf([0, -0]), 0)).toBe(true);
    expect(Object.is(minOf([0, -0]), -0)).toBe(true);
    expect(Object.is(minOf([-0, 0]), -0)).toBe(true);
    expect(Object.is(maxOf([-0]), -0)).toBe(true);
  });

  it('splitting a list into a head and maxOf / minOf of the rest is the spread call (the codemod rewrite)', () => {
    for (const values of corpus()) {
      const [head = 3, ...rest] = values;
      expect(Object.is(Math.max(head, maxOf(rest)), Math.max(head, ...rest))).toBe(true);
      expect(Object.is(Math.min(head, minOf(rest)), Math.min(head, ...rest))).toBe(true);
      const half = Math.floor(values.length / 2);
      const [left, right] = [values.slice(0, half), values.slice(half)];
      expect(Object.is(Math.max(maxOf(left), maxOf(right)), Math.max(...values))).toBe(true);
      expect(Object.is(Math.min(minOf(left), minOf(right)), Math.min(...values))).toBe(true);
    }
  });

  it('read typed arrays, sets and generators like the spread does', () => {
    expect(maxOf(new Float64Array([3, -1, 7]))).toBe(7);
    expect(minOf(new Set([3, -1, 7]))).toBe(-1);
    expect(
      maxOf(
        (function* () {
          yield 2;
          yield 9;
        })(),
      ),
    ).toBe(9);
  });

  it('handle 1e6 values where the spread throws RangeError', () => {
    const values = Array.from({ length: 1_000_000 }, (_, i) => Math.sin(i));
    expect(() => Math.max(...values)).toThrow(RangeError);
    let largest = -Infinity;
    let smallest = Infinity;
    for (const value of values) {
      if (value > largest) largest = value;
      if (value < smallest) smallest = value;
    }
    expect(maxOf(values)).toBe(largest);
    expect(minOf(values)).toBe(smallest);
  });
});
