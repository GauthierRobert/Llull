import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { migrateRetiredCommands } from '@core/commands/persistence/retiredCommands';
import { installPlugin } from '@core/plugins/host';
import { xy, xyz } from '../../helpers/xy';
import { expectNoOp } from '../../helpers/expectNoOp';

installPlugin({
  name: 'retired-test',
  toolset: 'core',
  commands: [],
  retiredCommands: {
    legacy_cube: ({ edge, ...rest }) => ({ name: 'legacy_box', params: { ...rest, side: edge } }),
    legacy_box: ({ side, ...rest }) => ({ name: 'add_box', params: { ...rest, size: [side, side, side] } }),
  },
});

/** A saved document whose history was recorded with the retired names. */
function savedWithRetiredSteps(): string {
  const doc = createEmptyDocument();
  const legacy: CadDocument = {
    ...doc,
    featureHistory: [
      { id: 'step-1', name: 'legacy_cube', params: { edge: 2 } },
      {
        id: 'step-2',
        name: 'build_project',
        params: {
          actions: [
            { command: 'legacy_box', params: { side: 3 } },
            { repeat: { count: 2 }, step: { command: 'legacy_cube', params: { edge: 1 } } },
          ],
        },
      },
    ],
    recipes: { cube: { name: 'cube', steps: [{ id: 'step-1', name: 'legacy_box', params: { side: 4 } }] } },
  };
  return serializeDocument(legacy);
}

describe('retired command migration', () => {
  it('rewrites history steps, nested plan actions and recipe steps (chained rewrites too)', () => {
    const loaded = deserializeDocument(savedWithRetiredSteps());
    expect(loaded.featureHistory[0]).toMatchObject({ name: 'add_box', params: { size: [2, 2, 2] } });
    expect(loaded.featureHistory[1]?.params).toEqual({
      actions: [
        { command: 'add_box', params: { size: [3, 3, 3] } },
        { repeat: { count: 2 }, step: { command: 'add_box', params: { size: [1, 1, 1] } } },
      ],
    });
    expect(loaded.recipes['cube']?.steps[0]).toMatchObject({ name: 'add_box', params: { size: [4, 4, 4] } });
  });
  it('replays the migrated history', () => {
    const loaded = deserializeDocument(savedWithRetiredSteps());
    const replayed = execute(loaded, 'replay_history', {}).document;
    expect(Object.values(replayed.entities).filter((entity) => entity.kind === 'box')).toHaveLength(4);
  });
  it('leaves current documents and malformed steps untouched', () => {
    const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const raw = JSON.parse(serializeDocument(doc)).document as Record<string, unknown>;
    expect(migrateRetiredCommands(raw)).toEqual(raw);
    const odd = { featureHistory: [null, { name: 7 }], recipes: { r: 'x' } };
    expect(migrateRetiredCommands(odd)).toEqual(odd);
    expect(migrateRetiredCommands({ featureHistory: 'nope' })).toEqual({ featureHistory: 'nope' });
  });
  it('maps animate_spin / animate_oscillate onto animate', () => {
    const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const boxId = doc.order[0]!;
    const saved = serializeDocument({
      ...doc,
      featureHistory: [
        ...doc.featureHistory,
        { id: 'step-2', name: 'animate_spin', params: { targetId: boxId, speed: 2 } },
        { id: 'step-3', name: 'animate_oscillate', params: { targetId: boxId, amplitude: 1, frequency: 0.5 } },
      ],
    });
    const replayed = execute(deserializeDocument(saved), 'replay_history', {}).document;
    expect(Object.values(replayed.animations).map((anim) => anim.mode)).toEqual(['spin', 'oscillate']);
  });
  it('maps add_mate onto add_constraint, keeping the minted mate id', () => {
    let doc = createEmptyDocument();
    for (const x of [0, 10]) {
      const box = execute(doc, 'add_box', { size: [1, 1, 1], position: [x, 0, 0] });
      doc = execute(box.document, 'create_component', { name: `C${x}`, entityIds: [box.affected[0]!] }).document;
    }
    const [first, second] = doc.order;
    const nextStep = doc.featureHistory.length + 1;
    const saved = serializeDocument({
      ...doc,
      featureHistory: [
        ...doc.featureHistory,
        {
          id: `step-${nextStep}`,
          name: 'add_mate',
          params: { kind: 'distance', a: { instanceId: first }, b: { instanceId: second }, value: 4 },
        },
        { id: `step-${nextStep + 1}`, name: 'update_constraint', params: { id: `mate-${nextStep}.1`, patch: { value: 6 } } },
      ],
      nextStepNumber: nextStep + 2,
    });
    const loaded = deserializeDocument(saved);
    expect(loaded.featureHistory.at(-2)?.params).toEqual({
      constraint: { kind: 'distance', a: { entityId: first }, b: { entityId: second }, value: 4 },
      id: `mate-${nextStep}.1`,
    });
    const replayed = execute(loaded, 'replay_history', {}).document;
    expect(replayed.constraints[`mate-${nextStep}.1`]).toMatchObject({ kind: 'distance', value: 6 });
  });
  it('keeps an explicit add_mate id and mints fresh ids inside recipes', () => {
    const mate = { kind: 'coincident', a: { instanceId: 'i1' }, b: { instanceId: 'i2' } };
    const raw = migrateRetiredCommands({
      featureHistory: [{ id: 'step-1', name: 'add_mate', params: { ...mate, id: 'm' } }],
      recipes: { r: { name: 'r', steps: [{ id: 'step-1', name: 'add_mate', params: mate }] } },
    });
    expect((raw['featureHistory'] as Array<{ params: { id?: string } }>)[0]?.params.id).toBe('m');
    const recipes = raw['recipes'] as CadDocument['recipes'];
    expect(recipes['r']?.steps[0]?.params).not.toHaveProperty('id');
  });
});

const RETIRED = [
  'draw_line',
  'draw_circle',
  'extrude_sketch',
  'measure_volume',
  'look_at',
  'rename_layer',
  'set_layer_visibility',
  'set_layer_lock',
];

function load(
  steps: ReadonlyArray<{ name: string; params: unknown }>,
  extra: Record<string, unknown> = {},
): ReturnType<typeof deserializeDocument> {
  const base = createEmptyDocument();
  const featureHistory = steps.map((step, index) => ({ id: `step-${index + 1}`, ...step }));
  return deserializeDocument(serializeDocument({ ...base, featureHistory, ...extra } as never));
}

describe('retired core draw commands', () => {
  it('are no longer registered', () => {
    for (const name of RETIRED) expect(getCommand(name)).toBeUndefined();
  });
  it('rewrites draw_line, draw_circle and extrude_sketch steps and replays identical ids', () => {
    const loaded = load([
      { name: 'draw_line', params: { start: [0, 0], end: [4, 0], position: [1, 2, 3] } },
      { name: 'draw_circle', params: { center: [0, 0], radius: 2 } },
      { name: 'extrude_sketch', params: { id: 'circ-2.1', depth: 3 } },
    ]);
    expect(loaded.featureHistory.map((step) => step.name)).toEqual(['draw_polyline', 'draw_arc', 'extrude_profile']);
    expect(loaded.featureHistory[0]?.params).toEqual({ points: xy(0, 0, 4, 0), position: [1, 2, 3] });
    const replayed = execute(loaded, 'replay_history', {});
    expect(Object.keys(replayed.document.entities)).toEqual(['line-1.1', 'circ-2.1', 'ext-3.1']);
    expect(replayed.document.entities['line-1.1']).toMatchObject({ kind: 'line', start: [0, 0], end: [4, 0], position: [1, 2, 3] });
    expect(replayed.document.entities['circ-2.1']?.kind).toBe('circle');
  });
  it('rewrites camera and layer steps onto set_camera and update_layer', () => {
    const loaded = load([
      { name: 'rename_layer', params: { id: 'layer-default', name: 'Base' } },
      { name: 'set_layer_visibility', params: { id: 'layer-default', visible: false } },
      { name: 'set_layer_lock', params: { id: 'layer-default', locked: true } },
      { name: 'look_at', params: { target: [1, 2, 3] } },
      { name: 'measure_volume', params: { entityId: 'box-1.1' } },
    ]);
    expect(loaded.featureHistory.map((step) => step.name)).toEqual([
      'update_layer',
      'update_layer',
      'update_layer',
      'set_camera',
      'mass_properties',
    ]);
    expect(loaded.featureHistory[1]?.params).toEqual({ id: 'layer-default', visible: false });
  });
  it('rewrites retired calls nested in recorded build_project plans', () => {
    const loaded = load([
      {
        name: 'build_project',
        params: {
          actions: [
            { command: 'draw_line', params: { start: [0, 0], end: [1, 1] }, as: 'a' },
            { repeat: { count: 2 }, step: { command: 'draw_circle', params: { radius: 1 } } },
          ],
        },
      },
    ]);
    expect(loaded.featureHistory[0]?.params).toEqual({
      actions: [
        { command: 'draw_polyline', params: { points: xy(0, 0, 1, 1) }, as: 'a' },
        { repeat: { count: 2 }, step: { command: 'draw_arc', params: { radius: 1 } } },
      ],
    });
  });
});

type Call = { name: string; params: Record<string, unknown> };

/** Rewrite one retired call through a saved history step. */
function rewritten(name: string, params: Record<string, unknown>): Call {
  const migrated = migrateRetiredCommands({ featureHistory: [{ id: 'step-1', name, params }] });
  const step = (migrated['featureHistory'] as Call[])[0] as Call;
  return { name: step.name, params: step.params };
}

/** Run the rewritten call against `doc`. */
function runRewritten(doc: CadDocument, name: string, params: Record<string, unknown>): ReturnType<typeof execute> {
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
    expect(rewritten('delete_entity', { id: 'a' })).toEqual({ name: 'delete_entities', params: { ids: ['a'] } });
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
      expectNoOp(runRewritten(doc, 'delete_entity', bad), doc);
    }
  });
  it('rewrites calls nested in build_project actions', () => {
    const migrated = migrateRetiredCommands({
      featureHistory: [
        { id: 'step-1', name: 'build_project', params: { actions: [{ command: 'move_entity', params: { id: '$b', delta: [1, 0, 0] } }] } },
      ],
    });
    expect(JSON.stringify(migrated)).toContain('"command":"move_entities"');
    expect(JSON.stringify(migrated)).toContain('"ids":["$b"]');
  });
});

describe('retired path and arc distribution', () => {
  it('array_along_path becomes unoriented pattern_along_path with the same positions', () => {
    const { doc, id } = boxDoc();
    const path = xyz(0, 0, 0, 10, 0, 0, 10, 10, 0);
    const call = rewritten('array_along_path', { sourceId: id, path, count: 3, mode: 'place' });
    expect(call).toEqual({ name: 'pattern_along_path', params: { sourceId: id, path, count: 3, orient: false } });
    const result = runRewritten(doc, 'array_along_path', { sourceId: id, path, count: 3 });
    expect(entityAt(result, 1).position[0]).toBeCloseTo(10, 6);
    expect(entityAt(result, 2).position[1]).toBeCloseTo(10, 6);
  });
  it('array_along_path with count 1 keeps its midpoint placement', () => {
    const { doc, id } = boxDoc();
    const path = xyz(0, 0, 0, 10, 0, 0);
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
    const arc = { center: [0, 0, 0], normal: [0, 0, 1], radius: 10, startAngle: 0, endAngle: Math.PI };
    const four = runRewritten(doc, 'distribute_on_arc', { sourceId: id, ...arc, count: 3 });
    expect(four.affected).toHaveLength(3);
    expect(entityAt(four, 1).position[1]).toBeCloseTo(10, 3);
    const one = runRewritten(doc, 'distribute_on_arc', { sourceId: id, ...arc, count: 1 });
    expect(entityAt(one, 0).position[0]).toBeCloseTo(0, 3);
    expect(entityAt(one, 0).position[1]).toBeCloseTo(10, 3);
    const full = runRewritten(doc, 'distribute_on_arc', { sourceId: id, ...arc, endAngle: 2 * Math.PI, count: 4 });
    expect(entityAt(full, 2).position[0]).toBeCloseTo(-10, 3);
    expect(runRewritten(doc, 'distribute_on_arc', { sourceId: id, ...arc, radius: 0, count: 3 }).affected).toEqual([]);
    expect(rewritten('distribute_on_arc', { sourceId: id, count: 1 }).params).not.toHaveProperty('startOffset');
  });
  it('distribute_along_path becomes component instances along the path entity', () => {
    const { doc, id } = boxDoc();
    const made = execute(doc, 'create_component', { name: 'link', entityIds: [id] });
    const componentId = Object.keys(made.document.components)[0] as string;
    const path = execute(made.document, 'draw_polyline', { points: xy(0, 0, 20, 0), closed: false });
    const params = { pathId: path.affected[0], componentId, count: 3, tangentAlign: false, startOffset: 2, endOffset: 2, name: 'ignored' };
    expect(rewritten('distribute_along_path', params)).toEqual({
      name: 'pattern_along_path',
      params: { componentId, pathId: path.affected[0], count: 3, orient: false, startOffset: 2, endOffset: 2 },
    });
    const result = runRewritten(path.document, 'distribute_along_path', params);
    const instances = result.affected.map((k) => result.document.entities[k] as Entity);
    expect(instances.every((e) => e.kind === 'instance')).toBe(true);
    expect(instances.map((e) => e.position[0])).toEqual([expect.closeTo(2, 5), expect.closeTo(10, 5), expect.closeTo(18, 5)]);
  });
});

describe('retired make_tube_between', () => {
  it('becomes an add_cylinder centred on the midpoint with its axis along p2 - p1', () => {
    expect(rewritten('make_tube_between', { p1: [0, 0, 0], p2: [0, 0, 10], radius: 2, color: '#fff' })).toEqual({
      name: 'add_cylinder',
      params: { radius: 2, height: 10, position: [0, 0, 5], axis: [0, 0, 10], color: '#fff' },
    });
    const result = runRewritten(createEmptyDocument(), 'make_tube_between', { p1: [0, 0, 0], p2: [4, 0, 0], radius: 1 });
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
      expectNoOp(runRewritten(doc, 'make_tube_between', params), doc);
    }
  });
});

describe('retired boolean_* commands', () => {
  it('boolean_union / boolean_subtract / boolean_intersect become boolean with their op', () => {
    const raw = migrateRetiredCommands({
      featureHistory: ['union', 'subtract', 'intersect'].map((op, i) => ({
        id: `step-${i + 1}`,
        name: `boolean_${op}`,
        params: { a: 'box-1.1', b: 'cyl-2.1' },
      })),
    });
    expect(raw['featureHistory']).toEqual(
      ['union', 'subtract', 'intersect'].map((op, i) => ({
        id: `step-${i + 1}`,
        name: 'boolean',
        params: { op, a: 'box-1.1', b: 'cyl-2.1' },
      })),
    );
  });
});

/** Replay a saved document whose only history step is `instantiate_template` with `params`. */
function replayTemplate(params: Record<string, unknown>): CadDocument {
  const saved = serializeDocument({
    ...createEmptyDocument(),
    featureHistory: [{ id: 'step-1', name: 'instantiate_template', params }],
    nextStepNumber: 2,
  });
  return execute(deserializeDocument(saved), 'replay_history', {}).document;
}

const shapes = (doc: CadDocument): Entity[] => doc.order.map((id) => doc.entities[id] as Entity);

describe('retired instantiate_template', () => {
  it('is no longer registered', () => {
    expect(getCommand('instantiate_template')).toBeUndefined();
  });
  it('bolt_hole_pattern replays as the same circles on the bolt circle, with the same ids', () => {
    const doc = replayTemplate({
      template: 'bolt_hole_pattern',
      params: { count: 4, boltCircleRadius: 10, holeRadius: 1 },
      position: [0, 0, 5],
      color: '#123456',
    });
    expect(doc.featureHistory[0]?.name).toBe('build_project');
    const circles = shapes(doc);
    expect(circles.map((e) => e.id)).toEqual(['circ-1.1', 'circ-1.2', 'circ-1.3', 'circ-1.4']);
    circles.forEach((entity, k) => {
      expect(entity).toMatchObject({ kind: 'circle', radius: 1, position: [0, 0, 5], color: '#123456' });
      const [x, y] = (entity as Extract<Entity, { kind: 'circle' }>).center;
      expect(x).toBeCloseTo(10 * Math.cos((k * Math.PI) / 2));
      expect(y).toBeCloseTo(10 * Math.sin((k * Math.PI) / 2));
    });
  });
  it('flange replays as outer + bore + bolt holes', () => {
    const doc = replayTemplate({
      template: 'flange',
      params: { outerRadius: 20, boreRadius: 5, boltCount: 3, boltCircleRadius: 12, holeRadius: 1 },
    });
    expect(shapes(doc).map((e) => (e as Extract<Entity, { kind: 'circle' }>).radius)).toEqual([20, 5, 1, 1, 1]);
  });
  it('rectangular_plate_with_holes replays as the plate then the hole grid row by row', () => {
    const doc = replayTemplate({
      template: 'rectangular_plate_with_holes',
      params: { width: 40, height: 20, holeRows: 2, holeCols: 3, holeRadius: 2, marginX: 5, marginY: 5 },
    });
    const [plate, ...holes] = shapes(doc);
    expect(plate).toMatchObject({ id: 'rect-1.1', kind: 'rectangle', width: 40, height: 20 });
    expect(holes.map((e) => (e as Extract<Entity, { kind: 'circle' }>).center)).toEqual(xy(5, 5, 20, 5, 35, 5, 5, 15, 20, 15, 35, 15));
    const single = replayTemplate({
      template: 'rectangular_plate_with_holes',
      params: { width: 10, height: 10, holeRows: 1, holeCols: 1, holeRadius: 1, marginX: 2, marginY: 3 },
    });
    expect((shapes(single)[1] as Extract<Entity, { kind: 'circle' }>).center).toEqual([2, 3]);
  });
  it('invalid or unknown templates still create nothing', () => {
    const cases: Array<Record<string, unknown>> = [
      { template: 'gear', params: {} },
      { template: 'bolt_hole_pattern', params: { count: 0, boltCircleRadius: 5, holeRadius: 1 } },
      { template: 'bolt_hole_pattern', params: { count: 3, boltCircleRadius: 5, holeRadius: -1 } },
      { template: 'bolt_hole_pattern', params: 'nope' },
      { template: 'flange', params: { outerRadius: 5, boreRadius: 5, boltCount: 2, boltCircleRadius: 3, holeRadius: 1 } },
      {
        template: 'rectangular_plate_with_holes',
        params: { width: 10, height: 10, holeRows: 1e5, holeCols: 1e5, holeRadius: 1, marginX: 1, marginY: 1 },
      },
      {
        template: 'rectangular_plate_with_holes',
        params: { width: 10, height: 10, holeRows: 1, holeCols: 1, holeRadius: 1, marginX: -1, marginY: 1 },
      },
    ];
    for (const params of cases) expect(shapes(replayTemplate(params))).toEqual([]);
  });
});
