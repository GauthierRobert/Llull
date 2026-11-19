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

  it('apply ToNumber like the built-ins: undefined / null / strings / valueOf, one conversion per item, all items even after a NaN', () => {
    const asNumbers = (values: unknown[]): number[] => values as number[];
    const lists: unknown[][] = [
      [undefined],
      [1, undefined],
      [null],
      [null, -1],
      ['5'],
      ['5', 7],
      [' 3 ', '-0'],
      ['x', 2],
      [true, false],
      [[], [4]],
    ];
    for (const values of lists) {
      expect(Object.is(maxOf(asNumbers(values)), Math.max(...asNumbers(values))), `max ${String(values)}`).toBe(true);
      expect(Object.is(minOf(asNumbers(values)), Math.min(...asNumbers(values))), `min ${String(values)}`).toBe(true);
    }
    expect(maxOf(asNumbers([undefined]))).toBeNaN();
    expect(minOf(asNumbers([1, undefined]))).toBeNaN();
    expect(maxOf(asNumbers(['5']))).toBe(5);

    const trace = (log: string[]): unknown[] => [
      { valueOf: () => (log.push('a'), NaN) },
      2,
      { valueOf: () => (log.push('b'), 9) },
      { valueOf: () => (log.push('c'), -4) },
    ];
    for (const [helper, builtin] of [
      [maxOf, Math.max],
      [minOf, Math.min],
    ] as const) {
      const helperLog: string[] = [];
      const builtinLog: string[] = [];
      expect(Object.is(helper(asNumbers(trace(helperLog))), builtin(...asNumbers(trace(builtinLog))))).toBe(true);
      expect(helperLog).toEqual(['a', 'b', 'c']);
      expect(helperLog).toEqual(builtinLog);
    }
    const once = {
      calls: 0,
      valueOf(): number {
        return 10 + this.calls++;
      },
    };
    expect(maxOf(asNumbers([once, 3]))).toBe(10);
    expect(once.calls).toBe(1);
  });

  it('convert the items the spread read, even when a valueOf changes the source array', () => {
    const run = (call: (values: number[]) => number): number => {
      const values: unknown[] = [];
      values.push({ valueOf: () => ((values[1] = 100), (values.length = 1), 1) }, 5, 6);
      return call(values as number[]);
    };
    expect(run(maxOf)).toBe(run((values) => Math.max(...values)));
    expect(run(minOf)).toBe(run((values) => Math.min(...values)));
  });
});
