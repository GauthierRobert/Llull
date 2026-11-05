import { describe, expect, it } from 'vitest';
import { isTableRefusal, lookupConservative } from '@aec/shared/designTable';

const TABLE: readonly [readonly [number, number], ...Array<readonly [number, number]>] = [
  [20, 1],
  [40, 2],
  [60, 3],
];
const options = { code: 'T_OUT', label: 'speed', unit: 'km/h' } as const;

describe('lookupConservative', () => {
  it('returns the exact row without flagging a neighbour', () => {
    expect(lookupConservative(TABLE, 40, { ...options, direction: 'up' })).toEqual({ row: [40, 2], exact: true });
  });
  it('takes the next higher row going up and the previous row going down', () => {
    expect(lookupConservative(TABLE, 45, { ...options, direction: 'up' })).toEqual({ row: [60, 3], exact: false });
    expect(lookupConservative(TABLE, 45, { ...options, direction: 'down' })).toEqual({ row: [40, 2], exact: false });
  });
  it('refuses keys outside the domain, NaN included, naming the code and domain', () => {
    for (const key of [19.99, 60.01, Number.NaN]) {
      const outcome = lookupConservative(TABLE, key, { ...options, direction: 'up' });
      expect(isTableRefusal(outcome)).toBe(true);
      expect(outcome).toMatchObject({ code: 'T_OUT', domain: [20, 60] });
      expect((outcome as { message: string }).message).toContain('[20, 60] km/h');
    }
  });
});
