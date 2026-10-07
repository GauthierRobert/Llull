import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { FootingElement } from '@core/model/building';
import { footingRebarMass, scaleFor, stairVolume } from '@aec/takeoffBasics';

const footing = (width: number, length: number): FootingElement => ({
  id: 'footing-1',
  category: 'footing',
  mark: 'F1',
  entityIds: [],
  levelId: 'level-1',
  location: [0, 0],
  width,
  length,
  thickness: 500,
  topOffset: 0,
  material: 'concrete',
  reinforcement: { barDiameter: 16, spacing: 200, cover: 50 },
});

const AREA_OF_16MM_BAR = (Math.PI * 0.016 ** 2) / 4;

describe('takeoff math by hand', () => {
  it('weighs the two-way mat of a 1 m x 1 m pad: 5 bars each way of 0.9 m plus 10% laps', () => {
    const scale = scaleFor(createEmptyDocument());
    const expected = (5 * 0.9 + 5 * 0.9) * AREA_OF_16MM_BAR * 7850 * 1.1;
    expect(footingRebarMass(footing(1000, 1000), scale)).toBeCloseTo(expected, 6);
  });

  it('never returns a negative mass for a pad narrower than twice the cover', () => {
    const scale = scaleFor(createEmptyDocument());
    expect(footingRebarMass(footing(80, 1000), scale)).toBeGreaterThanOrEqual(0);
    expect(footingRebarMass(footing(80, 80), scale)).toBe(0);
  });

  it('sums stair steps as riser x tread x width x n(n+1)/2', () => {
    const volume = stairVolume({
      id: 'stair-1',
      category: 'stair',
      mark: 'S1',
      entityIds: [],
      levelId: 'level-1',
      start: [0, 0],
      angle: 0,
      width: 1000,
      riserCount: 4,
      riserHeight: 150,
      treadDepth: 300,
      material: 'concrete',
    });
    expect(volume).toBe(300 * 1000 * 150 * 10);
  });
});
