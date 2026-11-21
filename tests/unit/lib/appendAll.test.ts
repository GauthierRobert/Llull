import { describe, expect, it } from 'vitest';
import { appendAll } from '@lib/appendAll';

describe('appendAll', () => {
  it('appends in order and returns the new length, like push(...source)', () => {
    const target = [1, 2];
    const reference = [1, 2];
    expect(appendAll(target, [3, 4, 5])).toBe(reference.push(...[3, 4, 5]));
    expect(target).toEqual(reference);
    expect(appendAll(target, [])).toBe(5);
  });

  it('reads sets, generators, strings and typed arrays', () => {
    const target: Array<number | string> = [];
    appendAll(target, new Set([1, 2]));
    appendAll(
      target,
      (function* () {
        yield 3;
      })(),
    );
    appendAll(target, 'ab');
    appendAll(target, new Float64Array([4]));
    expect(target).toEqual([1, 2, 3, 'a', 'b', 4]);
  });

  it('reads the source in full first: appending an array or its iterator to itself doubles it once', () => {
    const self = [1, 2];
    appendAll(self, self);
    expect(self).toEqual([1, 2, 1, 2]);
    appendAll(self, self.values());
    expect(self).toEqual([1, 2, 1, 2, 1, 2, 1, 2]);
  });

  it('appends 1e6 items where the spread throws RangeError', () => {
    const source = Array.from({ length: 1_000_000 }, (_, i) => i);
    expect(() => [0].push(...source)).toThrow(RangeError);
    const target = [-1];
    expect(appendAll(target, source)).toBe(1_000_001);
    expect(target[1_000_000]).toBe(999_999);
  });
});
