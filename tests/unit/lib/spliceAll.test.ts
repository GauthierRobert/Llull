import { describe, expect, it } from 'vitest';
import { spliceAll } from '@lib/spliceAll';

const starts = [0, 1, 2, 5, 9, 10, 11, 100, -1, -3, -10, -11, -100, 0.7, -0.7, 2.9, -2.9, -0, NaN, Infinity, -Infinity];
const counts = [0, 1, 2, 3, 10, 11, 100, -1, -5, 0.5, 2.7, -0.4, -0, NaN, Infinity, -Infinity];
const inserts = [[], ['x'], ['x', 'y', 'z'], Array.from({ length: 13 }, (_, i) => `i${i}`)];

describe('spliceAll', () => {
  it('equals Array.prototype.splice with spread items on every start / deleteCount / insert, incl. negative and out-of-range', () => {
    for (const length of [0, 1, 4, 10])
      for (const start of starts)
        for (const deleteCount of counts)
          for (const items of inserts) {
            const expected = Array.from({ length }, (_, i) => `a${i}`);
            const actual = [...expected];
            const removedExpected = expected.splice(start, deleteCount, ...items);
            const removedActual = spliceAll(actual, start, deleteCount, items);
            const label = `len ${length} start ${start} count ${deleteCount} items ${items.length}`;
            expect(actual, label).toEqual(expected);
            expect(removedActual, label).toEqual(removedExpected);
          }
  });

  it('reads the items before changing the target, as the spread does (an array spliced into itself, a generator over it)', () => {
    const expected = [1, 2, 3, 4];
    const actual = [1, 2, 3, 4];
    expected.splice(1, 2, ...expected);
    spliceAll(actual, 1, 2, actual);
    expect(actual).toEqual(expected);
    const source = [5, 6, 7];
    const viaGenerator = (function* () {
      yield* source;
    })();
    spliceAll(source, 0, 1, viaGenerator);
    expect(source).toEqual([5, 6, 7, 6, 7]);
  });

  it('keeps holes of the moved tail as holes and returns the removed holes as holes', () => {
    // eslint-disable-next-line no-sparse-arrays -- the holes are the point
    const make = (): (number | undefined)[] => [1, , 3, , 5];
    const expected = make();
    const actual = make();
    const removedExpected = expected.splice(1, 1, 9, 9);
    const removedActual = spliceAll(actual, 1, 1, [9, 9]);
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
    expect(actual.length).toBe(expected.length);
    expect(Object.keys(removedActual)).toEqual(Object.keys(removedExpected));
    expect(removedActual.length).toBe(removedExpected.length);
  });

  it('inserts 1e6 items where the spread throws RangeError', () => {
    const items = new Array<number>(1_000_000).fill(1);
    expect(() => [0].splice(0, 0, ...items)).toThrow(RangeError);
    const target = [7, 8];
    expect(spliceAll(target, 1, 0, items)).toEqual([]);
    expect(target.length).toBe(1_000_002);
    expect([target[0], target[1], target[1_000_001]]).toEqual([7, 1, 8]);
  });
});
