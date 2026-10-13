import { describe, it, expect } from 'vitest';
import type { DrawingPrimitive } from '@core/model/drawing';
import { planAnchor } from '../../src/ui/viewport/2d/planAnchor';
import { xy } from '../helpers/xy';
import type { Entity } from '@core/model/types';
import { computePlanDepth } from '@ui/viewport/2d/planDepth';

const base = { layer: 'A-WALL', style: 'cut' } as const;

describe('planAnchor', () => {
  it('is the first point of the first primitive that has one', () => {
    const primitives: DrawingPrimitive[] = [
      { ...base, type: 'polygon', points: [] },
      { ...base, type: 'polygon', points: xy(1_000_000, 2_000_000, 1_000_010, 2_000_000) },
    ];
    expect(planAnchor(primitives)).toEqual([1_000_000, 2_000_000]);
  });
  it('handles lines, arcs and text, and falls back to the origin', () => {
    expect(planAnchor([{ ...base, type: 'line', a: [3, 4], b: [5, 6] }])).toEqual([3, 4]);
    expect(planAnchor([{ ...base, type: 'arc', center: [7, 8], radius: 1, startAngle: 0, endAngle: 1 }])).toEqual([7, 8]);
    expect(planAnchor([])).toEqual([0, 0]);
  });
});

const at = (z: number): Entity => ({ position: [0, 0, z] }) as unknown as Entity;

describe('computePlanDepth', () => {
  it('keeps the default framing for a flat document', () => {
    expect(computePlanDepth(['a'], { a: at(0) })).toEqual({ top: 0, floor: 0, far: 10100 });
  });
  it('shifts to the topmost plane and widens far over the spread', () => {
    const { top, floor, far } = computePlanDepth(['a', 'b', 'c'], { a: at(0), b: at(99000), c: at(106000) });
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
