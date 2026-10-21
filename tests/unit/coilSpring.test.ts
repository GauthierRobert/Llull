import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { SweepEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { rotatedEntityBounds } from '@core/geometry/rotatedBounds';
import { expectPure } from '../helpers/expectNoOp';

/** add_coil as a compression spring (length, closedEnds): the former add_helix_spring. */
describe('add_coil: spring mode', () => {
  const spec = { sectionDiameter: 2, radius: 10, pitch: 5, turns: 8 };
  it('builds a sweep spring with the requested bounds and data', () => {
    const r = execute(createEmptyDocument(), 'add_coil', spec);
    expect(r.affected).toHaveLength(1);
    const e = r.document.entities[r.affected[0]!] as SweepEntity;
    expect(e.kind).toBe('sweep');
    expect(e.section).toEqual({ shape: 'circle', radius: 1 });
    expect(r.document.order).toEqual(r.affected);
    const b = rotatedEntityBounds(e);
    expect(b.max[0]).toBeGreaterThan(10.8);
    expect(b.max[0]).toBeLessThan(11.2);
    expect(b.min[2]).toBeCloseTo(0, 0);
    expect(b.max[2]).toBeCloseTo(42, 0);
    expect(r.data).toMatchObject({ height: 42, turns: 8, pitch: 5 });
  });
  it('resolves turns from length, honors axis and position', () => {
    const r = execute(createEmptyDocument(), 'add_coil', {
      sectionRadius: 1,
      radius: 8,
      turns: 5,
      length: 32,
      axis: [1, 0, 0],
      position: [10, 0, 0],
      name: 'Return spring',
    });
    const e = r.document.entities[r.affected[0]!]!;
    expect(e.name).toBe('Return spring');
    const b = rotatedEntityBounds(e);
    expect(b.min[0]).toBeCloseTo(10, 0);
    expect(b.max[0]).toBeCloseTo(42, 0);
    expect((r.data as { pitch: number }).pitch).toBeCloseTo(6);
  });
  it('resolves turns from pitch and length', () => {
    const r = execute(createEmptyDocument(), 'add_coil', { sectionRadius: 1, radius: 8, pitch: 4, length: 22 });
    expect((r.data as { turns: number }).turns).toBeCloseTo(5);
  });
  it('closedEnds keeps the length and flattens end coils', () => {
    const r = execute(createEmptyDocument(), 'add_coil', { sectionDiameter: 2, radius: 10, turns: 8, length: 60, closedEnds: true });
    const b = rotatedEntityBounds(r.document.entities[r.affected[0]!]!);
    expect(b.max[2]).toBeCloseTo(60, 0);
    expect((r.data as { pitch: number }).pitch).toBeCloseTo((58 - 4) / 6);
  });
  it('is pure and rejects bad input with a no-op', () => {
    const doc = createEmptyDocument();
    expectPure(doc, () => execute(doc, 'add_coil', spec));
    const bad: Array<Record<string, unknown>> = [
      { radius: 10, pitch: 5, turns: 8 },
      { ...spec, radius: 0.5 },
      { ...spec, pitch: 1 },
      { sectionDiameter: 2, radius: 10, pitch: 5 },
      { ...spec, turns: 500 },
      { ...spec, axis: [0, 0, 0] },
      { ...spec, closedEnds: true, turns: 2 },
      { ...spec, sectionDiameter: -1 },
      { ...spec, sectionShape: 'rectangle', sectionWidth: 1, sectionHeight: 1, closedEnds: true },
    ];
    for (const params of bad) {
      const r = execute(doc, 'add_coil', params);
      expect(r.affected, JSON.stringify(params)).toEqual([]);
      expect(r.document).toBe(doc);
      expect(r.summary.length).toBeGreaterThan(10);
    }
  });
});
