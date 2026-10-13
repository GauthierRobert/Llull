import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { SweepEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { rotatedEntityBounds } from '@core/geometry/rotatedBounds';
import { expectPure } from '../helpers/expectNoOp';

describe('add_helix_spring', () => {
  const spec = { wireDiameter: 2, coilRadius: 10, pitch: 5, turns: 8 };
  it('builds a sweep spring with the requested bounds and data', () => {
    const r = execute(createEmptyDocument(), 'add_helix_spring', spec);
    expect(r.affected).toHaveLength(1);
    const e = r.document.entities[r.affected[0]!] as SweepEntity;
    expect(e.kind).toBe('sweep');
    expect(e.section).toEqual({ shape: 'circle', radius: 1 });
    expect(r.document.order).toEqual(r.affected);
    const b = rotatedEntityBounds(e);
    expect(b.max[0]).toBeGreaterThan(10.8);
    expect(b.max[0]).toBeLessThan(11.2);
    expect(b.min[0]).toBeGreaterThan(-11.2);
    expect(b.min[2]).toBeCloseTo(0, 0);
    expect(b.max[2]).toBeCloseTo(42, 0);
    expect(r.data).toMatchObject({ freeLength: 42, turns: 8, pitch: 5, outerDiameter: 22 });
  });
  it('samples the path per turn (turn count)', () => {
    const r = execute(createEmptyDocument(), 'add_helix_spring', spec);
    const e = r.document.entities[r.affected[0]!] as SweepEntity;
    expect(e.path.length).toBe(8 * 16);
    const last = e.path[e.path.length - 1]!.points.at(-1)!;
    expect(last[2]).toBeCloseTo(40);
    expect(Math.hypot(last[0], last[1])).toBeLessThan(1e-6);
  });
  it('resolves turns from length, honors axis and position', () => {
    const r = execute(createEmptyDocument(), 'add_helix_spring', {
      wireRadius: 1,
      coilRadius: 8,
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
    expect(b.max[1]).toBeGreaterThan(8.5);
    expect(b.max[1]).toBeLessThan(9.3);
    expect((r.data as { pitch: number }).pitch).toBeCloseTo(6);
  });
  it('resolves turns from pitch and length', () => {
    const r = execute(createEmptyDocument(), 'add_helix_spring', { wireRadius: 1, coilRadius: 8, pitch: 4, length: 22 });
    expect((r.data as { turns: number }).turns).toBeCloseTo(5);
  });
  it('closedEnds keeps the length and flattens end coils', () => {
    const r = execute(createEmptyDocument(), 'add_helix_spring', {
      wireDiameter: 2,
      coilRadius: 10,
      turns: 8,
      length: 60,
      closedEnds: true,
    });
    const b = rotatedEntityBounds(r.document.entities[r.affected[0]!]!);
    expect(b.max[2]).toBeCloseTo(60, 0);
    expect((r.data as { pitch: number }).pitch).toBeCloseTo((58 - 4) / 6);
  });
  it('is pure and rejects bad input with a no-op', () => {
    const doc = createEmptyDocument();
    expectPure(doc, () => execute(doc, 'add_helix_spring', spec));
    const bad: Array<Record<string, unknown>> = [
      { coilRadius: 10, pitch: 5, turns: 8 },
      { ...spec, coilRadius: 0.5 },
      { ...spec, pitch: 1 },
      { wireDiameter: 2, coilRadius: 10, pitch: 5 },
      { ...spec, turns: 500 },
      { ...spec, axis: [0, 0, 0] },
      { ...spec, closedEnds: true, turns: 2 },
      { ...spec, wireDiameter: -1 },
      { ...spec, position: [1] },
    ];
    for (const params of bad) {
      const r = execute(doc, 'add_helix_spring', params);
      expect(r.affected, JSON.stringify(params)).toEqual([]);
      expect(r.document).toBe(doc);
      expect(r.summary.length).toBeGreaterThan(10);
    }
  });
});
