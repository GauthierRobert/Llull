import { describe, expect, it } from 'vitest';
import { memoByObject } from '@lib/memoByObject';

describe('memoByObject', () => {
  it('computes once per key object and again for an equal but distinct object', () => {
    let calls = 0;
    const size = memoByObject((list: readonly number[]) => {
      calls += 1;
      return { count: list.length };
    });
    const first = [1, 2, 3];
    expect(size(first)).toBe(size(first));
    expect(size(first)).toEqual({ count: 3 });
    expect(calls).toBe(1);
    expect(size([1, 2, 3])).toEqual({ count: 3 });
    expect(calls).toBe(2);
  });

  it('remembers an undefined or null result instead of recomputing it', () => {
    let calls = 0;
    const nothing = memoByObject((_key: object): undefined => {
      calls += 1;
      return undefined;
    });
    const key = {};
    expect(nothing(key)).toBeUndefined();
    expect(nothing(key)).toBeUndefined();
    expect(calls).toBe(1);
  });
});
