import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

const expectNoOp = (doc: CadDocument, name: string, params: Record<string, unknown>): void => {
  const result = execute(doc, name, params);
  expect(result.document).toBe(doc);
  expect(result.affected).toEqual([]);
  expect(result.summary).toMatch(/already|nothing/);
};

describe('update_* / set_* commands with unchanged values are no-ops', () => {
  it('update_wall', () => {
    const doc = execute(createEmptyDocument(), 'add_wall', {
      start: [0, 0],
      end: [4000, 0],
      thickness: 200,
    }).document;
    expectNoOp(doc, 'update_wall', { wallId: 'wall-1' });
    expectNoOp(doc, 'update_wall', { wallId: 'wall-1', thickness: 200, end: [4000, 0] });
    const changed = execute(doc, 'update_wall', { wallId: 'wall-1', thickness: 250 });
    expect(changed.affected.length).toBeGreaterThan(0);
  });

  it('update_steel_member', () => {
    const doc = execute(createEmptyDocument(), 'add_steel_member', {
      profile: 'IPE300',
      role: 'beam',
      start: [0, 0, 3000],
      end: [4000, 0, 3000],
    }).document;
    expectNoOp(doc, 'update_steel_member', { memberId: 'member-1' });
    expectNoOp(doc, 'update_steel_member', { memberId: 'member-1', profile: 'IPE300' });
    const changed = execute(doc, 'update_steel_member', {
      memberId: 'member-1',
      profile: 'IPE400',
    });
    expect(changed.affected.length).toBeGreaterThan(0);
  });

  it('move_building_element: zero delta no-op, duplicates counted once, unknown ids reported', () => {
    const doc = execute(createEmptyDocument(), 'add_wall', {
      start: [0, 0],
      end: [4000, 0],
    }).document;
    expectNoOp(doc, 'move_building_element', { elementIds: ['wall-1'], delta: [0, 0] });
    const moved = execute(doc, 'move_building_element', {
      elementIds: ['wall-1', 'wall-1', 'nope'],
      delta: [0, 500],
    });
    expect(moved.summary).toMatch(
      /Moved 1 element\(s\) by \[0, 500\]: wall-1\. Ignored unknown id\(s\): nope\./,
    );
    const deleted = execute(moved.document, 'delete_building_element', {
      elementIds: ['wall-1', 'nope'],
    });
    expect(deleted.summary).toMatch(
      /Deleted 1 building element\(s\): wall-1\. Ignored unknown id\(s\): nope\./,
    );
  });

  it('add_wall / draw_walls refuse a duplicate of an existing wall (either direction)', () => {
    const doc = execute(createEmptyDocument(), 'add_wall', {
      start: [0, 0],
      end: [4000, 0],
    }).document;
    for (const [start, end] of [
      [
        [0, 0],
        [4000, 0],
      ],
      [
        [4000, 0],
        [0, 0],
      ],
    ]) {
      const again = execute(doc, 'add_wall', { start, end });
      expect(again.document).toBe(doc);
      expect(again.summary).toMatch(/duplicates wall wall-1 on level-1/);
    }
    const chain = execute(doc, 'draw_walls', {
      points: [
        [4000, 3000],
        [4000, 0],
        [0, 0],
      ],
    });
    expect(chain.document).toBe(doc);
    const elsewhere = execute(doc, 'add_wall', { start: [0, 0], end: [4000, 0], baseOffset: 100 });
    expect(elsewhere.affected.length).toBeGreaterThan(0);
  });

  it('add_column skips occupied locations and refuses when all are occupied', () => {
    let doc = execute(createEmptyDocument(), 'add_column', { location: [1000, 1000] }).document;
    const same = execute(doc, 'add_column', { location: [1000, 1000] });
    expect(same.document).toBe(doc);
    expect(same.summary).toMatch(/a column already stands at \[1000, 1000\] \(column-1\)/);
    doc = execute(doc, 'add_grid_system', { xSpacings: [4000], ySpacings: [4000] }).document;
    const grid = execute(doc, 'add_column', { atGridIntersections: true });
    expect(grid.affected.length).toBeGreaterThan(0);
    const again = execute(grid.document, 'add_column', { atGridIntersections: true });
    expect(again.document).toBe(grid.document);
    expect(again.summary).toMatch(/columns already stand at/);
  });

  it('add_beam refuses a duplicate span (either direction) but allows another topOffset', () => {
    const doc = execute(createEmptyDocument(), 'add_beam', {
      start: [0, 0],
      end: [5000, 0],
    }).document;
    for (const [start, end] of [
      [
        [0, 0],
        [5000, 0],
      ],
      [
        [5000, 0],
        [0, 0],
      ],
    ]) {
      const again = execute(doc, 'add_beam', { start, end });
      expect(again.document).toBe(doc);
      expect(again.summary).toMatch(/beam beam-1 already spans/);
    }
    const lower = execute(doc, 'add_beam', { start: [0, 0], end: [5000, 0], topOffset: -500 });
    expect(lower.affected.length).toBeGreaterThan(0);
  });

  it('set_project_info', () => {
    const doc = execute(createEmptyDocument(), 'set_project_info', { name: 'Hall' }).document;
    expectNoOp(doc, 'set_project_info', { name: 'Hall' });
    expect(execute(doc, 'set_project_info', { name: 'Hall B' }).summary).toMatch(/updated/);
  });

  it('set_cost_rates', () => {
    const doc = execute(createEmptyDocument(), 'set_cost_rates', {
      rates: { 'wall.concrete.m3': 180 },
      currency: 'EUR',
    }).document;
    expectNoOp(doc, 'set_cost_rates', { rates: { 'wall.concrete.m3': 180 } });
    expectNoOp(doc, 'set_cost_rates', { rates: { 'wall.concrete.m3': 180 }, replace: true });
    const changed = execute(doc, 'set_cost_rates', { rates: { 'wall.concrete.m3': 190 } });
    expect(changed.summary).toMatch(/Stored 1 cost rate/);
  });
});
