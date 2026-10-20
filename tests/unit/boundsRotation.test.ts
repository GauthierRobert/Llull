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

  it('rotated cylinder bbox is tight (60 degrees about Z)', () => {
    const added = execute(createEmptyDocument(), 'add_cylinder', {
      radius: 0.5,
      height: 2,
      position: [2.5, 4.330127018922193, 0],
      rotation: [0, 0, Math.PI / 3],
    });
    const b = bbox(added.document, added.affected[0]!);
    expect(b.max[1]!).toBeCloseTo(4.330127018922193 + 0.5, 6);
    expect(b.min[1]!).toBeCloseTo(4.330127018922193 - 0.5, 6);
  });

  it('tilted cylinder, cone, sphere and torus use closed-form extents', () => {
    const tilt = Math.PI / 2;
    const cyl = execute(createEmptyDocument(), 'add_cylinder', { radius: 1, height: 4, rotation: [tilt, 0, 0] });
    const c = bbox(cyl.document, cyl.affected[0]!);
    expect(c.max[1]!).toBeCloseTo(2, 6);
    expect(c.max[2]!).toBeCloseTo(1, 6);
    const cone = execute(createEmptyDocument(), 'add_cone', { radius: 1, height: 3, rotation: [tilt, 0, 0] });
    const k = bbox(cone.document, cone.affected[0]!);
    expect(k.max[2]!).toBeCloseTo(1, 6);
    expect(k.min[1]!).toBeCloseTo(-3, 6);
    const sph = execute(createEmptyDocument(), 'add_sphere', { radius: 2, rotation: [0.7, 0.3, 0.2] });
    expect(bbox(sph.document, sph.affected[0]!).max[0]!).toBeCloseTo(2, 6);
    const tor = execute(createEmptyDocument(), 'add_torus', { ringRadius: 3, tubeRadius: 0.5, rotation: [tilt, 0, 0] });
    const t = bbox(tor.document, tor.affected[0]!);
    expect(t.max[2]!).toBeCloseTo(3.5, 6);
    expect(t.max[1]!).toBeCloseTo(0.5, 6);
  });
});
