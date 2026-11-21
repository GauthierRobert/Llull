import { describe, expect, it } from 'vitest';
import { hypotOf } from '@lib/hypotOf';
import { hypot3 } from '@lib/vec3';

describe('hypotOf', () => {
  it('is bit-identical to Math.hypot of the spread on a random corpus (1–9 values, many magnitudes)', () => {
    let state = 987654321;
    const next = (): number => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    for (let list = 0; list < 20_000; list++) {
      const length = 1 + Math.floor(next() * 9);
      const values = Array.from({ length }, () => (next() - 0.5) * 10 ** Math.floor(next() * 40 - 20));
      expect(Object.is(hypotOf(values), Math.hypot(...values)), values.join(',')).toBe(true);
    }
  });

  it('matches the fixed-arity calls the codemod replaced (tuples)', () => {
    for (const [x, y, z] of [
      [3, 4, 12],
      [0.1, 0.2, 0.3],
      [1e-300, 1e-300, 0],
      [1e300, 1e300, 1e300],
      [-2.5, 7.25, -1e-8],
    ] as const) {
      expect(Object.is(hypotOf([x, y, z]), Math.hypot(x, y, z))).toBe(true);
      expect(Object.is(hypotOf([x, y]), Math.hypot(x, y))).toBe(true);
    }
  });

  it('pins the special values like Math.hypot', () => {
    for (const values of [
      [],
      [0],
      [-0],
      [-0, -0],
      [NaN],
      [NaN, Infinity],
      [Infinity, NaN],
      [-Infinity],
      [NaN, 0],
      [5],
      [-5],
      [Number.MIN_VALUE],
    ]) {
      expect(Object.is(hypotOf(values), Math.hypot(...values)), values.join(',')).toBe(true);
    }
  });

  it('handles 1e6 values where the spread throws RangeError', () => {
    const values = new Float64Array(1_000_000).fill(1);
    expect(() => Math.hypot(...values)).toThrow(RangeError);
    expect(hypotOf(values)).toBe(1000);
  });

  it('applies ToNumber like Math.hypot: undefined / null / strings / valueOf, once each, in order, all items even after a NaN', () => {
    const asNumbers = (values: unknown[]): number[] => values as number[];
    for (const values of [[undefined, 0], [undefined, Infinity], [null, 3], ['3', '4'], ['x', 1], [' 5 '], [true, [2]]] as unknown[][]) {
      expect(Object.is(hypotOf(asNumbers(values)), Math.hypot(...asNumbers(values))), String(values)).toBe(true);
    }
    expect(hypotOf(asNumbers([undefined, 0]))).toBeNaN();
    expect(hypotOf(asNumbers(['3', '4']))).toBe(5);
    const trace = (log: string[]): unknown[] => [
      { valueOf: () => (log.push('a'), NaN) },
      { valueOf: () => (log.push('b'), Infinity) },
      { valueOf: () => (log.push('c'), 1) },
    ];
    const helperLog: string[] = [];
    const builtinLog: string[] = [];
    expect(Object.is(hypotOf(asNumbers(trace(helperLog))), Math.hypot(...asNumbers(trace(builtinLog))))).toBe(true);
    expect(helperLog).toEqual(['a', 'b', 'c']);
    expect(helperLog).toEqual(builtinLog);
    const once = {
      calls: 0,
      valueOf(): number {
        return 3 + this.calls++;
      },
    };
    expect(hypotOf(asNumbers([once, 4]))).toBe(5);
    expect(once.calls).toBe(1);
  });

  it('reads generators and typed arrays like the spread', () => {
    const generate = function* (): Generator<number> {
      yield 3;
      yield 4;
    };
    expect(hypotOf(generate())).toBe(Math.hypot(...generate()));
    expect(hypotOf(new Float32Array([0.1, 0.2]))).toBe(Math.hypot(...new Float32Array([0.1, 0.2])));
  });

  it('Math.hypot(v[0], v[1], v[2]) and hypot3(v) equal Math.hypot(...v) and hypotOf(v) (the Vec3 hot-loop rewrite)', () => {
    let state = 424242;
    const next = (): number => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const specials = [0, -0, NaN, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE, 1e-310, 1e308];
    for (let k = 0; k < 50_000; k++) {
      const pick = (): number =>
        next() < 0.05 ? (specials[Math.floor(next() * specials.length)] as number) : (next() - 0.5) * 10 ** Math.floor(next() * 40 - 20);
      const v: [number, number, number] = [pick(), pick(), pick()];
      const spread = Math.hypot(...v);
      expect(Object.is(Math.hypot(v[0], v[1], v[2]), spread), v.join(',')).toBe(true);
      expect(Object.is(hypot3(v), spread), v.join(',')).toBe(true);
      expect(Object.is(hypotOf(v), spread), v.join(',')).toBe(true);
    }
  });
});
