import { describe, expect, it } from 'vitest';
import { bisect } from '@lib/bisect';

describe('bisect', () => {
  it('brackets the root of a monotone predicate', () => {
    const { low, high } = bisect((x) => x * x < 2, 0, 2);
    expect(low).toBeCloseTo(Math.SQRT2, 12);
    expect(high).toBeCloseTo(Math.SQRT2, 12);
    expect(low).toBeLessThanOrEqual(high);
  });
  it('honours the step count', () => {
    expect(bisect(() => true, 0, 8, 3)).toEqual({ low: 7, high: 8 });
    expect(bisect(() => false, 0, 8, 0)).toEqual({ low: 0, high: 8 });
  });
});
