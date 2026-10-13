import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { rotatedEntityBounds } from '@core/geometry/rotatedBounds';
import { lookupBearing } from '@core/commands/solids/bearingTable';

interface BearingData {
  groupId: string;
  innerRingId: string;
  outerRingId: string;
  rollingElementIds: string[];
  type: string;
  bore: number;
  outerDiameter: number;
  width: number;
}

describe('add_bearing', () => {
  it('creates rings, balls and one group for designation 6205', () => {
    const doc = createEmptyDocument();
    const r = execute(doc, 'add_bearing', { designation: '6205' });
    const data = r.data as BearingData;
    expect(data).toMatchObject({
      type: 'deep_groove_ball',
      bore: 25,
      outerDiameter: 52,
      width: 15,
    });
    expect(r.document.entities[data.innerRingId]!.kind).toBe('revolution');
    expect(r.document.entities[data.outerRingId]!.kind).toBe('revolution');
    expect(data.rollingElementIds.length).toBeGreaterThanOrEqual(6);
    for (const id of data.rollingElementIds) expect(r.document.entities[id]!.kind).toBe('sphere');
    const group = r.document.groups[data.groupId]!;
    expect(group.name).toBe('Bearing 6205');
    expect(group.memberIds).toEqual([data.innerRingId, data.outerRingId, ...data.rollingElementIds]);
    expect(r.affected).toEqual([...group.memberIds, data.groupId]);
    expect(r.document.order).toEqual(group.memberIds);
    const outer = rotatedEntityBounds(r.document.entities[data.outerRingId]!);
    expect(outer.max[0] - outer.min[0]).toBeCloseTo(52, 0);
    expect(outer.max[2] - outer.min[2]).toBeCloseTo(15);
  });

  it('places roller bearings and honors axis, position and explicit dimensions', () => {
    const doc = createEmptyDocument();
    const r = execute(doc, 'add_bearing', {
      designation: 'nu 210',
      axis: [1, 0, 0],
      position: [5, 0, 0],
      name: 'Shaft bearing',
    });
    const data = r.data as BearingData;
    expect(data.type).toBe('cylindrical_roller');
    expect(r.document.groups[data.groupId]!.name).toBe('Shaft bearing');
    const outer = rotatedEntityBounds(r.document.entities[data.outerRingId]!);
    expect(outer.max[0] - outer.min[0]).toBeCloseTo(20);
    expect(outer.max[1] - outer.min[1]).toBeCloseTo(90, 0);
    expect((outer.max[0] + outer.min[0]) / 2).toBeCloseTo(5);
    expect(r.document.entities[data.rollingElementIds[0]!]!.kind).toBe('cylinder');

    const explicit = execute(doc, 'add_bearing', {
      type: 'tapered_roller',
      bore: 40,
      outerDiameter: 80,
      width: 20,
    });
    expect((explicit.data as BearingData).type).toBe('tapered_roller');
    const spherical = execute(doc, 'add_bearing', { designation: '22220' });
    expect((spherical.data as BearingData).outerDiameter).toBe(180);
    const tapered = execute(doc, 'add_bearing', { designation: '30210-A' });
    expect((tapered.data as BearingData).width).toBe(21.75);
  });

  it('scales table dimensions to the document units', () => {
    const doc = { ...createEmptyDocument(), units: 'cm' as const };
    const r = execute(doc, 'add_bearing', { designation: '6205' });
    expect((r.data as BearingData).outerDiameter).toBeCloseTo(5.2);
  });

  it('is pure', () => {
    const doc = createEmptyDocument();
    const before = JSON.stringify(doc);
    execute(doc, 'add_bearing', { designation: '6205' });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('rejects unknown designation, mismatched type and bad dimensions as no-ops', () => {
    const doc = createEmptyDocument();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ designation: '9999' }, /unknown designation "9999"/],
      [{ designation: '6205', type: 'tapered_roller' }, /deep_groove_ball/],
      [{}, /designation/],
      [{ bore: 10, outerDiameter: 30 }, /designation/],
      [{ bore: -1, outerDiameter: 30, width: 5 }, /finite and > 0/],
      [{ bore: 29, outerDiameter: 30, width: 5 }, /exceed bore/],
      [{ designation: '6205', axis: [0, 0, 0] }, /axis/],
      [{ designation: '6205', position: [1] }, /position/],
    ];
    for (const [params, message] of cases) {
      const r = execute(doc, 'add_bearing', params);
      expect(r.affected).toEqual([]);
      expect(r.document).toBe(doc);
      expect(r.summary).toMatch(message);
    }
  });

  it('table lookup is case/space tolerant', () => {
    expect(lookupBearing(' 6205-2RS ')?.bore).toBe(25);
    expect(lookupBearing('xyz')).toBeUndefined();
  });
});
