import { describe, it, expect } from 'vitest';
import type { Entity } from '@core/model/types';
import { computePlanDepth } from '@ui/viewport/2d/planDepth';

const at = (z: number): Entity => ({ position: [0, 0, z] }) as unknown as Entity;

describe('computePlanDepth', () => {
  it('keeps the default framing for a flat document', () => {
    expect(computePlanDepth(['a'], { a: at(0) })).toEqual({ top: 0, floor: 0, far: 10100 });
  });

  it('shifts to the topmost plane and widens far over the spread', () => {
    const { top, floor, far } = computePlanDepth(['a', 'b', 'c'], {
      a: at(0),
      b: at(99000),
      c: at(106000),
    });
    expect(top).toBe(106000);
    expect(floor).toBe(-106000);
    expect(far).toBe(100 + 106000 + 10000);
  });

  it('handles negative elevations and ignores missing / non-finite z', () => {
    const { top, far } = computePlanDepth(['a', 'x', 'n'], { a: at(-500), n: at(NaN) });
    expect(top).toBe(0);
    expect(far).toBe(100 + 500 + 10000);
  });
});
