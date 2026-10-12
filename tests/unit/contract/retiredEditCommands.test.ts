/** Retired edit commands (move/delete/duplicate_entity, path/arc distribution, tubes) rewrite onto their replacements. */
import { describe, it, expect } from 'vitest';
import { type CadDocument, type Entity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { migrateRetiredCommands } from '@core/commands/persistence/retiredCommands';

type Call = { name: string; params: Record<string, unknown> };

/** Rewrite one retired call through a saved history step. */
function rewritten(name: string, params: Record<string, unknown>): Call {
  const migrated = migrateRetiredCommands({
    featureHistory: [{ id: 'step-1', name, params }],
  });
  const step = (migrated['featureHistory'] as Call[])[0] as Call;
  return { name: step.name, params: step.params };
}

/** Run the rewritten call against `doc`. */
function runRewritten(
  doc: CadDocument,
  name: string,
  params: Record<string, unknown>,
): ReturnType<typeof execute> {
  const call = rewritten(name, params);
  return execute(doc, call.name, call.params);
}

function boxDoc(): { doc: CadDocument; id: string } {
  const created = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
  return { doc: created.document, id: created.affected[0] as string };
}

const entityAt = (result: ReturnType<typeof execute>, index: number): Entity =>
  result.document.entities[result.affected[index] as string] as Entity;

describe('retired single-entity edits', () => {
  it('move_entity / delete_entity / duplicate_entity become their batch forms', () => {
    expect(rewritten('move_entity', { id: 'a', delta: [1, 2, 3] })).toEqual({
      name: 'move_entities',
      params: { ids: ['a'], delta: [1, 2, 3] },
    });
    expect(rewritten('delete_entity', { id: 'a' })).toEqual({
      name: 'delete_entities',
      params: { ids: ['a'] },
    });
    expect(rewritten('duplicate_entity', { id: 'a', offset: [5, 0, 0] })).toEqual({
      name: 'duplicate_entities',
      params: { ids: ['a'], offset: [5, 0, 0] },
    });
    expect(rewritten('duplicate_entity', { id: 'a' }).params).toEqual({ ids: ['a'] });
  });

  it('replays with the same effect and a missing or malformed id stays a no-op', () => {
    const { doc, id } = boxDoc();
    const moved = runRewritten(doc, 'move_entity', { id, delta: [5, 0, -2] });
    expect(moved.affected).toEqual([id]);
    expect(moved.document.entities[id]?.position).toEqual([5, 0, -2]);
    const copy = runRewritten(doc, 'duplicate_entity', { id, offset: [10, 0, 0] });
    expect(entityAt(copy, 0).position).toEqual([10, 0, 0]);
    const removed = runRewritten(doc, 'delete_entity', { id });
    expect(removed.document.entities[id]).toBeUndefined();
    for (const bad of [{ id: 'ghost' }, { id: 7 }, {}]) {
      const result = runRewritten(doc, 'delete_entity', bad);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    }
  });

  it('rewrites calls nested in build_project actions', () => {
    const migrated = migrateRetiredCommands({
      featureHistory: [
        {
          id: 'step-1',
          name: 'build_project',
          params: { actions: [{ command: 'move_entity', params: { id: '$b', delta: [1, 0, 0] } }] },
        },
      ],
    });
    expect(JSON.stringify(migrated)).toContain('"command":"move_entities"');
    expect(JSON.stringify(migrated)).toContain('"ids":["$b"]');
  });
});

describe('retired path and arc distribution', () => {
  it('array_along_path becomes unoriented pattern_along_path with the same positions', () => {
    const { doc, id } = boxDoc();
    const path = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
    ];
    const call = rewritten('array_along_path', { sourceId: id, path, count: 3, mode: 'place' });
    expect(call).toEqual({
      name: 'pattern_along_path',
      params: { sourceId: id, path, count: 3, orient: false },
    });
    const result = runRewritten(doc, 'array_along_path', { sourceId: id, path, count: 3 });
    expect(entityAt(result, 1).position[0]).toBeCloseTo(10, 6);
    expect(entityAt(result, 2).position[1]).toBeCloseTo(10, 6);
  });

  it('array_along_path with count 1 keeps its midpoint placement', () => {
    const { doc, id } = boxDoc();
    const path = [
      [0, 0, 0],
      [10, 0, 0],
    ];
    const result = runRewritten(doc, 'array_along_path', { sourceId: id, path, count: 1 });
    expect(entityAt(result, 0).position[0]).toBeCloseTo(5, 6);
    expect(rewritten('array_along_path', { sourceId: id, path: 'x', count: 1 }).params).toEqual({
      sourceId: id,
      path: 'x',
      count: 1,
      orient: false,
    });
  });

  it('distribute_on_arc keeps the arc positions, including the single mid-arc copy', () => {
    const { doc, id } = boxDoc();
    const arc = {
      center: [0, 0, 0],
      normal: [0, 0, 1],
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI,
    };
    const four = runRewritten(doc, 'distribute_on_arc', { sourceId: id, ...arc, count: 3 });
    expect(four.affected).toHaveLength(3);
    expect(entityAt(four, 1).position[1]).toBeCloseTo(10, 3);
    const one = runRewritten(doc, 'distribute_on_arc', { sourceId: id, ...arc, count: 1 });
    expect(entityAt(one, 0).position[0]).toBeCloseTo(0, 3);
    expect(entityAt(one, 0).position[1]).toBeCloseTo(10, 3);
    const full = runRewritten(doc, 'distribute_on_arc', {
      sourceId: id,
      ...arc,
      endAngle: 2 * Math.PI,
      count: 4,
    });
    expect(entityAt(full, 2).position[0]).toBeCloseTo(-10, 3);
    expect(
      runRewritten(doc, 'distribute_on_arc', { sourceId: id, ...arc, radius: 0, count: 3 })
        .affected,
    ).toEqual([]);
    expect(rewritten('distribute_on_arc', { sourceId: id, count: 1 }).params).not.toHaveProperty(
      'startOffset',
    );
  });

  it('distribute_along_path becomes component instances along the path entity', () => {
    const { doc, id } = boxDoc();
    const made = execute(doc, 'create_component', { name: 'link', entityIds: [id] });
    const componentId = Object.keys(made.document.components)[0] as string;
    const path = execute(made.document, 'draw_polyline', {
      points: [
        [0, 0],
        [20, 0],
      ],
      closed: false,
    });
    const params = {
      pathId: path.affected[0],
      componentId,
      count: 3,
      tangentAlign: false,
      startOffset: 2,
      endOffset: 2,
      name: 'ignored',
    };
    expect(rewritten('distribute_along_path', params)).toEqual({
      name: 'pattern_along_path',
      params: {
        componentId,
        pathId: path.affected[0],
        count: 3,
        orient: false,
        startOffset: 2,
        endOffset: 2,
      },
    });
    const result = runRewritten(path.document, 'distribute_along_path', params);
    const instances = result.affected.map((k) => result.document.entities[k] as Entity);
    expect(instances.every((e) => e.kind === 'instance')).toBe(true);
    expect(instances.map((e) => e.position[0])).toEqual([
      expect.closeTo(2, 5),
      expect.closeTo(10, 5),
      expect.closeTo(18, 5),
    ]);
  });
});

describe('retired make_tube_between', () => {
  it('becomes an add_cylinder centred on the midpoint with its axis along p2 - p1', () => {
    expect(
      rewritten('make_tube_between', { p1: [0, 0, 0], p2: [0, 0, 10], radius: 2, color: '#fff' }),
    ).toEqual({
      name: 'add_cylinder',
      params: { radius: 2, height: 10, position: [0, 0, 5], axis: [0, 0, 10], color: '#fff' },
    });
    const result = runRewritten(createEmptyDocument(), 'make_tube_between', {
      p1: [0, 0, 0],
      p2: [4, 0, 0],
      radius: 1,
    });
    const tube = entityAt(result, 0);
    expect(tube.kind).toBe('cylinder');
    expect(tube.position).toEqual([2, 0, 0]);
    expect(tube).toMatchObject({ radius: 1, height: 4 });
  });

  it('stays a no-op for coincident or malformed points', () => {
    const doc = createEmptyDocument();
    for (const params of [
      { p1: [1, 1, 1], p2: [1, 1, 1], radius: 1 },
      { p1: 'a', p2: [1, 1, 1], radius: 1 },
    ]) {
      const result = runRewritten(doc, 'make_tube_between', params);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    }
  });
});
