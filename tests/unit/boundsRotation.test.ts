import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { xy } from '../helpers/xy';

function bbox(doc: ReturnType<typeof createEmptyDocument>, entityId?: string): { min: number[]; max: number[] } {
  const r = execute(doc, 'measure_bounding_box', entityId ? { entityId } : {});
  return r.data as { min: number[]; max: number[] };
}

describe('measure_bounding_box honours rotation and partial revolve', () => {
  it('rotated box: 90 degrees about Z swaps X/Y extents', () => {
    const added = execute(createEmptyDocument(), 'add_box', { size: [4, 2, 2], rotation: [0, 0, Math.PI / 2] });
    const id = added.affected[0]!;
    const b = bbox(added.document, id);
    expect(b.max[0]! - b.min[0]!).toBeCloseTo(2, 6);
    expect(b.max[1]! - b.min[1]!).toBeCloseTo(4, 6);
    const whole = bbox(added.document);
    expect(whole.max[1]! - whole.min[1]!).toBeCloseTo(4, 6);
  });

  it('90 degree revolve about Z covers only the first quadrant', () => {
    const r = execute(createEmptyDocument(), 'revolve_profile', { profile: xy(1, 0, 3, 0, 3, 2, 1, 2), axis: 'z', angle: Math.PI / 2 });
    const b = bbox(r.document, r.affected[0]!);
    expect(b.min[0]!).toBeCloseTo(0, 6);
    expect(b.min[1]!).toBeCloseTo(0, 6);
    expect(b.max[0]!).toBeCloseTo(3, 6);
    expect(b.max[1]!).toBeCloseTo(3, 6);
    expect(b.max[2]!).toBeCloseTo(2, 6);
  });

  it('full revolve stays symmetric', () => {
    const r = execute(createEmptyDocument(), 'revolve_profile', { profile: xy(1, 0, 3, 0, 3, 2, 1, 2), axis: 'z' });
    const b = bbox(r.document, r.affected[0]!);
    expect(b.min[0]!).toBeCloseTo(-3, 6);
    expect(b.max[1]!).toBeCloseTo(3, 6);
  });

  it('110 degree sweep from -55..55 style: extends to negative Y only via the arc', () => {
    const r = execute(createEmptyDocument(), 'revolve_profile', {
      profile: xy(1, 0, 3, 0, 3, 2, 1, 2),
      axis: 'z',
      angle: (110 * Math.PI) / 180,
    });
    const b = bbox(r.document, r.affected[0]!);
    expect(b.min[0]!).toBeCloseTo(3 * Math.cos((110 * Math.PI) / 180), 6);
    expect(b.max[1]!).toBeCloseTo(3, 6);
    expect(b.min[1]!).toBeCloseTo(0, 6);
  });
});
