import { describe, it, expect, vi } from 'vitest';
import { type CadDocument, type Entity, type TextEntity, createEmptyDocument, is2D } from '@core/model/types';
import { execute, toToolSchemas, listCommands, getCommand } from '@core/commands/registry';
import { entityBounds } from '@core/geometry/bounds';
import { evaluateExpression, extractReferences } from '@core/commands/parametric/expression';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence/serialization';
import { resolveStepParams, buildParamEnv, remapIds } from '@core/commands/history/regenerate';
import { expectNoOp, expectPure, expectSingleEntity } from '../helpers/expectNoOp';
import { add } from '../helpers/addEntity';
import { run } from '../helpers/runFixtures';
import { xy, xyz } from '../helpers/xy';

type Loose = Entity & Record<string, unknown>;
const empty = createEmptyDocument;
const first = (r: ReturnType<typeof execute>): Loose => r.document.entities[r.affected[0]!] as Loose;
const box = (doc: CadDocument = empty(), size = [1, 1, 1]): { doc: CadDocument; id: string } => add(doc, 'add_box', { size });
const boxes = (n: number): { doc: CadDocument; ids: string[] } => {
  let doc = empty();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ({ doc, id: ids[i] } = box(doc));
  return { doc, ids };
};
const { doc: boxDoc, id: boxId } = box();

describe('command layer', () => {
  it.each<[string, object, Record<string, unknown>, string[]]>([
    ['add_box', { size: [2, 2, 2] }, { kind: 'box' }, []],
    ['add_cylinder', { radius: 2, height: 5 }, { kind: 'cylinder', radius: 2, height: 5 }, []],
    ['add_sphere', { radius: 4 }, { kind: 'sphere', radius: 4 }, []],
    ['add_cone', { radius: 3, height: 7 }, { kind: 'cone', radius: 3, height: 7 }, ['3', '7']],
    ['add_torus', { ringRadius: 5, tubeRadius: 1.5 }, { kind: 'torus', ringRadius: 5, tubeRadius: 1.5 }, []],
    ['add_wedge', { size: [4, 3, 6] }, { kind: 'wedge', size: [4, 3, 6] }, ['4×3×6']],
    ['add_pyramid', { baseWidth: 6, baseDepth: 4, height: 8 }, { kind: 'pyramid', baseWidth: 6, baseDepth: 4, height: 8 }, ['6', '4', '8']],
  ])('%s creates one entity, purely', (name, params, shape, summary) => {
    const doc = empty();
    const r = execute(doc, name, params);
    expectSingleEntity(r, shape['kind'] as string);
    expect(first(r)).toMatchObject(shape);
    for (const s of name === 'add_box' ? summary : [r.affected[0]!, ...summary]) expect(r.summary).toContain(s);
    expectPure(doc, () => execute(doc, name, params));
  });

  it.each<[string, object, ...string[]]>([
    ['add_cylinder', { radius: 0, height: 5 }, 'radius'],
    ['add_cylinder', { radius: 3, height: -1 }, 'height'],
    ['add_sphere', { radius: -5 }, 'radius'],
    ['add_sphere', { radius: 0 }],
    ['add_cone', { radius: 0, height: 5 }, 'radius'],
    ['add_cone', { radius: 3, height: -1 }, 'height'],
    ['add_torus', { ringRadius: 0, tubeRadius: 1 }, 'ringRadius'],
    ['add_torus', { ringRadius: 3, tubeRadius: -0.5 }, 'tubeRadius'],
    ['add_wedge', { size: [0, 3, 5] }, 'size'],
    ['add_wedge', { size: [2, -1, 5] }],
    ['add_pyramid', { baseWidth: 0, baseDepth: 3, height: 5 }, 'baseWidth'],
    ['add_pyramid', { baseWidth: 3, baseDepth: -2, height: 5 }, 'baseDepth'],
    ['add_pyramid', { baseWidth: 3, baseDepth: 4, height: 0 }, 'height'],
    ['move_entities', { ids: ['nope'], delta: [1, 1, 1] }],
    ['delete_entities', { ids: ['ghost'] }, 'ghost'],
    ['set_entity_name', { id: 'ghost', name: 'Nope' }, 'ghost'],
    ['find_entities', { bboxMin: [0, 0, 0] }, 'bboxMin', 'bboxMax'],
    ['set_parameter', { name: '1invalid', expression: '10' }, 'invalid'],
    ['set_parameter', { name: 'x', expression: '' }],
    ['delete_parameter', { name: 'nonexistent' }, 'nonexistent'],
    ['draw_ellipse', { center: [0, 0], radiusX: 0, radiusY: 3 }, 'radiusX'],
    ['draw_ellipse', { center: [0, 0], radiusX: 3, radiusY: -1 }, 'radiusY'],
    ['draw_spline', { points: [[0, 0]] }, '2'],
    ['draw_spline', { points: [] }],
    ['animate', { mode: 'spin', targetId: 'no-such-id', speed: 1.0 }, 'no-such-id'],
    ['animate', { mode: 'oscillate', targetId: 'ghost', amplitude: 1.0, frequency: 1.0 }, 'ghost'],
    ['animate', { mode: 'oscillate', targetId: boxId, amplitude: 0, frequency: 1.0 }, 'amplitude'],
    ['animate', { mode: 'oscillate', targetId: boxId, amplitude: 1.0, frequency: -1 }, 'frequency'],
    ['animate', { mode: 'spin', targetId: boxId }, 'speed'],
    ['animate', { mode: 'oscillate', targetId: boxId, frequency: 1 }, 'amplitude'],
    ['animate', { mode: 'oscillate', targetId: boxId, amplitude: 1 }, 'frequency'],
    ['stop_animation', { animationId: 'anim-ghost' }, 'anim-ghost', 'not found'],
  ])('%s %j is a safe no-op', (name, params, ...summary) => {
    const r = execute(boxDoc, name, params);
    expectNoOp(r, boxDoc);
    for (const s of summary) expect(r.summary).toContain(s);
  });

  it('move_entities translates; delete_entities removes from entities, order, selection', () => {
    const { doc, id } = box();
    expect(run(doc, 'move_entities', { ids: [id], delta: [5, 0, -2] }).entities[id]!.position).toEqual([5, 0, -2]);
    const d = execute({ ...doc, selection: [id] }, 'delete_entities', { ids: [id] }).document;
    expect([d.entities[id], d.order, d.selection]).toEqual([undefined, [], []]);
  });

  it.each([
    [2, [0], undefined],
    [3, [0], [1, 2]],
  ])('delete_entities prunes group members (%i members, delete %j)', (n, del, survivors) => {
    const { doc: d0, ids } = boxes(n);
    const g = execute(d0, 'group_entities', { ids, name: 'G' });
    const groupId = g.affected[0]!;
    expect(g.document.groups[groupId]!.memberIds).toEqual(ids);
    const r = execute(g.document, 'delete_entities', { ids: del.map((i) => ids[i]!) });
    expect(r.document.entities[ids[0]!]).toBeUndefined();
    expect(r.document.order).not.toContain(ids[0]);
    expect(r.document.groups[groupId]?.memberIds).toEqual(survivors?.map((i) => ids[i]));
    if (!survivors) expect(r.summary).toContain(groupId);
    expectPure(g.document, () => execute(g.document, 'delete_entities', { ids: [ids[0]!] }));
  });

  it('delete_entities on an ungrouped entity leaves groups unchanged', () => {
    const { doc: d0, ids } = boxes(3);
    const doc = run(d0, 'group_entities', { ids: ids.slice(0, 2) });
    const r = execute(doc, 'delete_entities', { ids: [ids[2]!] });
    expect(r.document.entities[ids[2]!]).toBeUndefined();
    expect(JSON.stringify(r.document.groups)).toBe(JSON.stringify(doc.groups));
  });

  it('unknown commands fail gracefully; getCommand; every command exposes a tool schema', () => {
    const doc = empty();
    const r = execute(doc, 'frobnicate', {});
    expect(r.summary).toContain('Unknown command');
    expect(r.document).toBe(doc);
    expect(getCommand('add_box')?.name).toBe('add_box');
    expect(getCommand('frobnicate')).toBeUndefined();
    const schemas = toToolSchemas();
    expect(schemas).toHaveLength(listCommands().length);
    for (const s of schemas) {
      expect(s.name).toBeTruthy();
      expect(s.input_schema.type).toBe('object');
    }
  });

  it('set_entity_name sets, keeps (omitted) and clears (empty) name and tags, purely', () => {
    const { doc, id } = box();
    const r = execute(doc, 'set_entity_name', { id, name: 'Left wall', tags: ['structural', 'visible'] });
    expect(r.affected).toEqual([id]);
    expect(first(r)).toMatchObject({ name: 'Left wall', tags: ['structural', 'visible'] });
    expect(r.summary).toContain(id);
    expect(r.summary).toContain('Left wall');
    const kept = execute(r.document, 'set_entity_name', { id });
    expect(kept.affected).toEqual([id]);
    expect(first(kept)).toMatchObject({ name: 'Left wall', tags: ['structural', 'visible'] });
    const cleared = run(r.document, 'set_entity_name', { id, name: '', tags: [] }).entities[id]!;
    expect([cleared.name, cleared.tags]).toEqual([undefined, undefined]);
    expectPure(doc, () => execute(doc, 'set_entity_name', { id, name: 'Test', tags: ['a'] }));
  });

  describe('find_entities', () => {
    const { doc: d1, id: id1 } = box(empty(), [2, 2, 2]);
    const doc = run(run(d1, 'add_sphere', { radius: 1, position: [10, 0, 0] }), 'set_entity_name', {
      id: id1,
      name: 'Left Wall',
      tags: ['structural'],
    });
    const find = (p: object): { count: number; matches: Array<Record<string, unknown>> } =>
      execute(doc, 'find_entities', p).data as { count: number; matches: Array<Record<string, unknown>> };

    it.each<[object, number, Record<string, unknown>?]>([
      [{}, 2],
      [{ kind: 'box' }, 1, { kind: 'box' }],
      [{ name: 'wall' }, 1, { id: id1, name: 'Left Wall' }],
      [{ name: 'Left Wall', nameExact: true }, 1],
      [{ name: 'left wall', nameExact: true }, 0],
      [{ tag: 'structural' }, 1, { id: id1 }],
      [{ layerId: 'layer-default' }, 2],
      [{ layerId: 'layer-nonexistent' }, 0],
      [{ bboxMin: [-2, -2, -2], bboxMax: [2, 2, 2] }, 1, { kind: 'box' }],
    ])('%j → %i match(es)', (filter, count, match) => {
      const data = find(filter);
      expect(data.count).toBe(count);
      expect(data.matches).toHaveLength(count);
      if (match) expect(data.matches[0]).toMatchObject(match);
    });

    it('is a pure query with a descriptive summary', () => {
      const r = execute(doc, 'find_entities', { kind: 'cone' });
      expectNoOp(r, doc, 'kind=cone');
      expect(r.summary).toContain('0 match');
      expect((execute(empty(), 'find_entities', {}).data as { count: number }).count).toBe(0);
      expectPure(doc, () => execute(doc, 'find_entities', { kind: 'box' }));
    });
  });
});

describe('evaluateExpression / extractReferences', () => {
  it.each<[string, Record<string, number>, number]>([
    ['42', {}, 42],
    ['3.14', {}, 3.14],
    ['1 + 2', {}, 3],
    ['10 - 4', {}, 6],
    ['3 * 4', {}, 12],
    ['10 / 4', {}, 2.5],
    ['2 + 3 * 4', {}, 14],
    ['(2 + 3) * 4', {}, 20],
    ['-5', {}, -5],
    ['10 + -3', {}, 7],
    ['((2 + 3) * (1 + 1))', {}, 10],
    ['width', { width: 15 }, 15],
    ['width * 2 + 5', { width: 10 }, 25],
  ])('%s = %d', (src, env, value) => expect(evaluateExpression(src, env)).toEqual({ ok: true, value: expect.closeTo(value, 9) }));

  it.each([
    ['unknown_var', 'unknown parameter: unknown_var'],
    ['1 / 0', 'not a finite number'],
    ['', 'empty'],
    ['2 @ 3', '@'],
    ['(2 + 3', ''],
    ['2 + 3 )', ''],
  ])('%j is an error', (src, error) => {
    const r = evaluateExpression(src, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(error);
  });

  it.each([
    ['42', []],
    ['width * 2', ['width']],
    ['a + b * c', ['a', 'b', 'c']],
    ['@@garbage@@', []],
  ])('extractReferences(%j)', (src, refs) => expect([...extractReferences(src)].sort()).toEqual(refs));
});

const params = (...pairs: Array<[string, string]>): CadDocument =>
  pairs.reduce((doc, [name, expression]) => run(doc, 'set_parameter', { name, expression }), empty());

describe('set_parameter / delete_parameter', () => {
  it('creates a literal parameter and reports it', () => {
    const r = execute(empty(), 'set_parameter', { name: 'width', expression: '10' });
    expect(r.document.parameters['width']).toMatchObject({ value: 10, expression: '10' });
    expect(r.document.parameters['width']!.error).toBeUndefined();
    expect(r.summary).toContain('width');
    expect(r.summary).toContain('10');
  });

  it('references and transitive re-evaluation', () => {
    const doc = params(['a', '2'], ['b', 'a * 3'], ['c', 'b + 1']);
    expect([doc.parameters['b']!.value, doc.parameters['c']!.value, doc.parameters['b']!.error]).toEqual([6, 7, undefined]);
    const r = execute(doc, 'set_parameter', { name: 'a', expression: '4' });
    expect(['a', 'b', 'c'].map((k) => r.document.parameters[k]!.value)).toEqual([4, 12, 13]);
    const updated = run(params(['r', '5']), 'set_parameter', { name: 'r', expression: '7' });
    expect(updated.parameters).toEqual({ r: expect.objectContaining({ value: 7 }) });
  });

  it('stores errors for unknown references and cycles; refuses parse errors without calling them cycles', () => {
    const r = execute(empty(), 'set_parameter', { name: 'x', expression: 'ghost * 2' });
    expect(r.document.parameters['x']!.error).toContain('unknown parameter');
    expect(r.summary).toContain('could not be evaluated');
    const cyc = run(params(['a', 'b']), 'set_parameter', { name: 'b', expression: 'a' }).parameters;
    expect(cyc['a']!.error !== undefined || cyc['b']!.error !== undefined).toBe(true);
    const doc = params(['width', '10']);
    const bad = execute(doc, 'set_parameter', { name: 'x', expression: 'width +' });
    expect(bad.document).toBe(doc);
    expect(bad.document.parameters['x']).toBeUndefined();
    expect(bad.summary).toContain('is invalid');
    expect(bad.summary).not.toContain('cycle');
  });

  it('is pure; parameters round-trip; legacy envelopes default parameters, featureHistory, configurations, materials', () => {
    const doc = empty();
    expectPure(doc, () => execute(doc, 'set_parameter', { name: 'width', expression: '10' }));
    const restored = deserializeDocument(serializeDocument(params(['width', '10'], ['height', 'width * 2'])));
    expect(restored.parameters['width']!.value).toBe(10);
    expect(restored.parameters['height']).toMatchObject({ value: 20, expression: 'width * 2' });
    const { entities, order, layers, layerOrder, selection, camera } = doc;
    const legacy = { format: 'llull-document', version: 1, document: { entities, order, layers, layerOrder, selection, camera } };
    expect(deserializeDocument(JSON.stringify(legacy))).toMatchObject({
      parameters: {},
      featureHistory: [],
      configurations: {},
      materials: {},
    });
  });

  it('delete_parameter removes, errors dependents, leaves others, purely', () => {
    const doc = params(['base', '10'], ['derived', 'base * 2'], ['other', '7']);
    expect(doc.parameters['derived']!.value).toBe(20);
    const r = execute(doc, 'delete_parameter', { name: 'base' });
    expect(r.document.parameters['base']).toBeUndefined();
    expect(r.document.parameters['derived']!.error).toContain('base');
    expect([r.document.parameters['other']!.value, r.document.parameters['other']!.error]).toEqual([7, undefined]);
    expect(r.summary).toContain('derived');
    const x = execute(params(['x', '5']), 'delete_parameter', { name: 'x' });
    expect(x.document.parameters['x']).toBeUndefined();
    expect(x.summary).toContain('x');
    expect(x.summary).toContain('removed');
    expectPure(doc, () => execute(doc, 'delete_parameter', { name: 'base' }));
  });
});

describe('draw_ellipse / draw_spline / scale_entity', () => {
  it('draw_ellipse creates one 2D ellipse at the default position, purely', () => {
    const doc = empty();
    const r = execute(doc, 'draw_ellipse', { center: [1, 2], radiusX: 5, radiusY: 3 });
    expectSingleEntity(r, 'ellipse');
    expect(first(r)).toMatchObject({ center: [1, 2], radiusX: 5, radiusY: 3, position: [0, 0, 0] });
    expect(is2D(first(r))).toBe(true);
    for (const s of [r.affected[0]!, '5', '3']) expect(r.summary).toContain(s);
    expectPure(doc, () => execute(doc, 'draw_ellipse', { center: [0, 0], radiusX: 4, radiusY: 2 }));
  });

  it('draw_spline creates an open or closed 2D spline, purely', () => {
    const doc = empty();
    const r = execute(doc, 'draw_spline', { points: xy(0, 0, 1, 2, 3, 1, 4, 3) });
    expectSingleEntity(r, 'spline');
    expect(first(r)).toMatchObject({ closed: false, points: xy(0, 0, 1, 2, 3, 1, 4, 3) });
    expect(is2D(first(r))).toBe(true);
    expect(r.summary).toContain(r.affected[0]);
    expect(r.summary).toContain('4');
    const closed = execute(doc, 'draw_spline', { points: xy(0, 0, 1, 1, 2, 0), closed: true });
    expect(first(closed).closed).toBe(true);
    expect(closed.summary).toContain('closed');
    expectPure(doc, () => execute(doc, 'draw_spline', { points: xy(0, 0, 1, 1, 2, 0) }));
  });

  it.each<[string, object, number, Record<string, unknown>, string[]]>([
    ['draw_ellipse', { center: [2, 4], radiusX: 3, radiusY: 1 }, 2, { center: [4, 8], radiusX: 6, radiusY: 2 }, ['radiusX', '6']],
    ['draw_spline', { points: xy(1, 0, 2, 2, 3, 0) }, 3, { points: xy(3, 0, 6, 6, 9, 0) }, ['3 points']],
    ['add_cone', { radius: 2, height: 4 }, 3, { radius: 6, height: 12 }, ['$id']],
    ['add_torus', { ringRadius: 4, tubeRadius: 1 }, 2, { ringRadius: 8, tubeRadius: 2 }, []],
    ['add_wedge', { size: [2, 3, 4] }, 2, { size: [4, 6, 8] }, []],
    ['add_pyramid', { baseWidth: 3, baseDepth: 4, height: 6 }, 2, { baseWidth: 6, baseDepth: 8, height: 12 }, []],
  ])('scale_entity scales %s, purely', (name, p, factor, shape, summary) => {
    const { doc, id } = add(empty(), name, p);
    const r = execute(doc, 'scale_entity', { id, factor });
    expect(r.affected).toEqual([id]);
    expect(first(r)).toMatchObject(shape);
    for (const s of summary) expect(r.summary).toContain(s === '$id' ? id : s);
    expectPure(doc, () => execute(doc, 'scale_entity', { id, factor }));
  });

  it.each([
    ['add_cone', { radius: 3, height: 4 }, (Math.PI * 3 * 3 * 4) / 3],
    ['add_torus', { ringRadius: 4, tubeRadius: 1 }, 2 * Math.PI * Math.PI * 4],
    ['add_wedge', { size: [4, 3, 6] }, (4 * 3 * 6) / 2],
    ['add_pyramid', { baseWidth: 6, baseDepth: 4, height: 9 }, (6 * 4 * 9) / 3],
  ])('mass_properties volume of %s', (name, p, volume) => {
    const { doc, id } = add(empty(), name, p);
    const r = execute(doc, 'mass_properties', { entityId: id });
    expectNoOp(r, doc);
    expect(r.data).toMatchObject({ volume: expect.closeTo(volume, 6), volumeUnit: expect.stringContaining('mm') });
  });
});

describe('animate / stop_animation', () => {
  const anims = (doc: CadDocument): Array<Record<string, unknown>> =>
    Object.values(doc.animations) as unknown as Array<Record<string, unknown>>;

  it.each<[object, Record<string, unknown>, string[]]>([
    [
      { mode: 'spin', speed: 1.0 },
      { mode: 'spin', channel: 'rotation', speed: 1.0, amplitude: 0, frequency: 0, trigger: 'auto', axis: [0, 1, 0] },
      [boxId, 'rad/s'],
    ],
    [
      { mode: 'spin', speed: 2.0, axis: [1, 0, 0], channel: 'position', pivot: [0, 0, 5], trigger: 'click' },
      { axis: [1, 0, 0], channel: 'position', pivot: [0, 0, 5], trigger: 'click' },
      ['units/s'],
    ],
    [
      { mode: 'oscillate', amplitude: 0.5, frequency: 2.0 },
      { mode: 'oscillate', channel: 'rotation', amplitude: 0.5, frequency: 2.0, speed: 0, trigger: 'auto' },
      [boxId, 'Hz'],
    ],
    [
      { mode: 'oscillate', amplitude: 1.0, frequency: 0.5, axis: [0, 0, 1], channel: 'position', pivot: [1, 2, 3], trigger: 'click' },
      { axis: [0, 0, 1], channel: 'position', pivot: [1, 2, 3], trigger: 'click' },
      ['units'],
    ],
  ])('animate %j adds one animation record, purely', (p, shape, summary) => {
    const r = execute(boxDoc, 'animate', { ...p, targetId: boxId });
    expect(r.affected).toHaveLength(0);
    expect(r.document).not.toBe(boxDoc);
    const list = anims(r.document);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ...shape, targetId: boxId, targetKind: 'entity' });
    if (!('pivot' in p)) expect('pivot' in list[0]!).toBe(false);
    for (const s of summary) expect(r.summary).toContain(s);
    expectPure(boxDoc, () => execute(boxDoc, 'animate', { ...p, targetId: boxId }));
  });

  it('animate on a group resolves targetKind group', () => {
    const { doc, ids } = boxes(2);
    const g = execute(doc, 'group_entities', { ids, name: 'Wheel' });
    const list = anims(run(g.document, 'animate', { mode: 'spin', targetId: g.affected[0], speed: 6.283 }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ targetKind: 'group', targetId: g.affected[0] });
  });

  it('stop_animation by animationId, by targetId, or all; no-ops explain themselves; pure', () => {
    const { doc: d0, ids } = boxes(2);
    const [a, b] = ids as [string, string];
    const doc = [
      { targetId: a, speed: 1 },
      { targetId: a, speed: 2 },
      { targetId: b, speed: 3 },
    ].reduce((d, p) => run(d, 'animate', { mode: 'spin', ...p }), d0);
    const [anim1, anim2] = Object.keys(doc.animations) as [string, string];
    const byId = execute(doc, 'stop_animation', { animationId: anim1 });
    expect([byId.document.animations[anim1], !!byId.document.animations[anim2]]).toEqual([undefined, true]);
    expect(byId.summary).toContain(anim1);
    const byTarget = execute(doc, 'stop_animation', { targetId: a });
    expect(anims(byTarget.document).map((x) => x['targetId'])).toEqual([b]);
    expect(byTarget.summary).toContain('2');
    expect(byTarget.summary).toContain(a);
    const none = execute(doc, 'stop_animation', { targetId: 'other-entity' });
    expect(none.document).toBe(doc);
    expect(none.summary).toContain('other-entity');
    const all = execute(doc, 'stop_animation', {});
    expect(all.document.animations).toEqual({});
    expect(all.summary).toContain('3');
    expect(all.summary).toContain('cleared');
    const nothing = execute(boxDoc, 'stop_animation', {});
    expect(nothing.document).toBe(boxDoc);
    expect(nothing.summary).toContain('no animations');
    expectPure(doc, () => execute(doc, 'stop_animation', { animationId: anim1 }));
  });

  it('describe_scene lists animations and counts them', () => {
    const before = execute(boxDoc, 'describe_scene', {});
    expect((before.data as { animations: unknown[] }).animations).toHaveLength(0);
    expect(before.summary).toContain('0 animation');
    const after = execute(run(boxDoc, 'animate', { mode: 'spin', targetId: boxId, speed: 2.0 }), 'describe_scene', {});
    expect((after.data as { animations: unknown[] }).animations).toEqual([
      expect.objectContaining({ targetId: boxId, targetKind: 'entity', channel: 'rotation', mode: 'spin' }),
    ]);
    expect(after.summary).toContain('1 animation');
  });
});

type RenderData = {
  svg: string;
  view: string;
  width: number;
  height: number;
  entityCount: number;
  bounds: unknown;
  camera: { position: number[]; target: number[]; up: number[] };
};
const render = (doc: CadDocument, p: object = {}): RenderData => execute(doc, 'render_view', { mode: 'vector', ...p }).data as RenderData;
const chain = (...steps: Array<[string, object]>): CadDocument => steps.reduce((doc, [name, p]) => run(doc, name, p), empty());

describe('render_view', () => {
  it('empty doc: valid 800×600 iso SVG, entityCount 0, bounds null, pure', () => {
    const doc = empty();
    const r = execute(doc, 'render_view', { mode: 'vector' });
    expectNoOp(r, doc, '0 entit');
    expect(r.summary).toContain('800×600');
    expect(r.data).toMatchObject({ entityCount: 0, bounds: null, view: 'iso', width: 800, height: 600 });
    for (const s of ['<svg', 'xmlns="http://www.w3.org/2000/svg"', '</svg>', 'width="800"', 'height="600"'])
      expect(render(doc).svg).toContain(s);
  });

  it('a box: polygons, bounds, camera, every view distinct, pure', () => {
    const doc = chain(['add_box', { size: [2, 2, 2], position: [0, 0, 0] }]);
    const r = execute(doc, 'render_view', { mode: 'vector', view: 'iso' });
    const data = r.data as RenderData;
    expect([data.entityCount, data.bounds === null]).toEqual([1, false]);
    expect(data.svg).toContain('<polygon');
    expect([data.camera.position.length, data.camera.target.length, data.camera.up.length]).toEqual([3, 3, 3]);
    expect(r.summary).toContain('1 entity');
    const svgs = (['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'] as const).map((view) => render(doc, { view }).svg);
    expect(svgs[0]).not.toBe(svgs[2]);
    expect(svgs[6]).not.toBe(svgs[0]);
    for (const svg of svgs) expect(svg).toContain('<svg');
    expectPure(doc, () => execute(doc, 'render_view', { mode: 'vector', view: 'iso' }));
    expectNoOp(execute(doc, 'render_view', { mode: 'vector', view: 'top' }), doc);
  });

  it('view names, size clamps, camera per axis view, invalid view rejected', () => {
    const doc = empty();
    expect(render(doc, { view: 'front' }).view).toBe('front');
    expect(render(doc, { view: 'top' }).view).toBe('top');
    for (const [p, size] of [
      [{ width: 5000, height: 9999 }, 2000],
      [{ width: 1, height: 5 }, 64],
    ] as const) {
      const data = render(doc, p);
      expect([data.width, data.height]).toEqual([size, size]);
      expect(data.svg).toContain(`width="${size}"`);
      expect(data.svg).toContain(`height="${size}"`);
    }
    const cams = (['top', 'bottom', 'front', 'back', 'left', 'right'] as const).map((view) => JSON.stringify(render(doc, { view }).camera));
    expect(new Set(cams).size).toBe(6);
    const bad = execute(doc, 'render_view', { mode: 'vector', view: 'diagonal' });
    expectNoOp(bad, doc, 'render_view rejected: invalid params');
    expect(bad.data).toBeUndefined();
    expect(toToolSchemas().find((s) => s.name === 'render_view')?.input_schema.required).toEqual([]);
  });

  it.each<[string, Array<[string, object]>, string, string, number?]>([
    ['circle arc', [['draw_arc', { center: [0, 0], radius: 3 }]], 'top', '<polyline'],
    [
      'box + cylinder + cone',
      [
        ['add_box', { size: [2, 2, 2] }],
        ['add_cylinder', { radius: 1, height: 3 }],
        ['add_cone', { radius: 1, height: 2 }],
      ],
      'iso',
      '<polygon',
      3,
    ],
    [
      'sphere, torus, wedge, pyramid',
      [
        ['add_sphere', { radius: 1 }],
        ['add_torus', { ringRadius: 2, tubeRadius: 0.5 }],
        ['add_wedge', { size: [2, 1, 3] }],
        ['add_pyramid', { baseWidth: 2, baseDepth: 2, height: 3 }],
      ],
      'iso',
      '<polygon',
      4,
    ],
    ['square extrusion', [['extrude_profile', { profile: xy(0, 0, 2, 0, 2, 2, 0, 2), depth: 1 }]], 'front', '<polygon', 1],
    ['triangle extrusion', [['extrude_profile', { profile: xy(0, 0, 1, 0, 1, 1), depth: 2 }]], 'iso', '<polygon'],
    [
      '2D rectangle, ellipse, spline, point, arc, line, polyline',
      [
        ['draw_rectangle', { width: 2, height: 1 }],
        ['draw_ellipse', { center: [0, 0], radiusX: 1, radiusY: 2 }],
        ['draw_spline', { points: xy(0, 0, 1, 1, 2, 0) }],
        ['draw_point', { position: [0, 0, 0] }],
        ['draw_arc', { center: [0, 0], radius: 1, startAngle: 0, endAngle: 1 }],
        ['draw_polyline', { points: xy(0, 0, 1, 1) }],
        ['draw_polyline', { points: xy(0, 0, 1, 0, 1, 1) }],
      ],
      'top',
      '<polyline',
      7,
    ],
    [
      'closed polyline and spline',
      [
        ['draw_polyline', { points: xy(0, 0, 1, 0, 0.5, 1), closed: true }],
        ['draw_spline', { points: xy(0, 0, 1, 0, 0.5, 1), closed: true }],
      ],
      'top',
      '<polyline',
    ],
    ['arc with endAngle < startAngle', [['draw_arc', { center: [0, 0], radius: 2, startAngle: 3, endAngle: 1 }]], 'front', '<polyline'],
  ])('renders %s', (_, steps, view, element, count) => {
    const doc = chain(...steps);
    const r = execute(doc, 'render_view', { mode: 'vector', view });
    const data = r.data as RenderData;
    expectNoOp(r, doc);
    expect(data.svg).toContain('<svg');
    expect(data.svg).toContain(element);
    if (count !== undefined) expect(data.entityCount).toBe(count);
    if (count === 3) expect(r.summary).toContain('3 entit');
  });

  it('painter depth sort is descending: the far (blue) box is drawn before the near (red) one in top view', () => {
    const doc = chain(
      ['add_box', { size: [2, 2, 2], position: [0, 0, -5], color: '#0000ff' }],
      ['add_box', { size: [2, 2, 2], position: [0, 0, 5], color: '#ff0000' }],
    );
    const svg = render(doc, { view: 'top' }).svg;
    const [blue, red] = [svg.indexOf('rgb(0,0,'), svg.indexOf(',0,0)')];
    expect(blue).toBeGreaterThan(-1);
    expect(red).toBeGreaterThan(-1);
    expect(blue).toBeLessThan(red);
  });
});

describe('add_text', () => {
  const text = (p: object): ReturnType<typeof execute> => execute(empty(), 'add_text', { position: [0, 0, 0], height: 1, ...p });

  it('creates a 2D text entity with fields and defaults, purely', () => {
    const r = text({ content: 'Hello World', position: [1, 2, 0], height: 5, anchor: 'center', color: '#ff0000' });
    expectSingleEntity(r, 'text');
    expect(first(r)).toMatchObject({ content: 'Hello World', height: 5, position: [1, 2, 0], anchor: 'center', color: '#ff0000' });
    expect(r.summary).toContain(r.affected[0]);
    expect(r.summary).toContain('Hello World');
    const d = text({ content: 'Label', height: 2 });
    expect(first(d)).toMatchObject({ anchor: 'left', rotation: [0, 0, 0], color: '#333333' });
    expect(is2D(first(d))).toBe(true);
    const doc = empty();
    expectPure(doc, () => execute(doc, 'add_text', { content: 'Test', position: [0, 0, 0], height: 1 }));
  });

  it.each([
    [{ content: '' }, 'non-empty'],
    [{ content: '   ' }, ''],
    [{ content: 'Hi', height: 0 }, 'height'],
    [{ content: 'Hi', height: -3 }, ''],
    [{ content: 'Hi', position: null }, 'position'],
    [{ content: 'Hi', position: [0] }, ''],
  ])('%j is a no-op', (p, summary) => {
    const doc = empty();
    expectNoOp(execute(doc, 'add_text', { position: [0, 0, 0], height: 1, ...p }), doc, summary);
  });

  it('scale_entity scales text height', () => {
    const { doc, id } = add(empty(), 'add_text', { content: 'Scale me', position: [0, 0, 0], height: 4 });
    const r = execute(doc, 'scale_entity', { id, factor: 2.5 });
    expect(r.affected).toEqual([id]);
    expect((r.document.entities[id] as TextEntity).height).toBeCloseTo(10);
    expect(r.summary).toContain('height');
  });
});

type MotionStudyData = import('@core/commands/motion/motionStudy').MotionStudyData;
type Joint = CadDocument['joints'][string];

/** Two instances of one component: A (the seed box) and B inserted at `at`. */
function instances(at = [2, 0, 0], seed: object = { size: [1, 1, 1] }): { doc: CadDocument; idA: string; idB: string } {
  const s = add(empty(), 'add_box', seed);
  const comp = execute(s.doc, 'create_component', { name: 'Part', entityIds: [s.id] });
  const b = add(comp.document, 'insert_instance', { componentId: Object.keys(comp.document.components)[0], position: at });
  return { doc: b.doc, idA: comp.affected[0]!, idB: b.id };
}

function joint(doc: CadDocument, a: string, b: string, kind: string, axis: unknown, value?: unknown): { doc: CadDocument; jid: string } {
  let d = run(doc, 'add_joint', { kind, a: { instanceId: a }, b: { instanceId: b }, axis });
  const jid = d.jointOrder.at(-1)!;
  if (value !== undefined) d = run(d, 'set_joint_value', { id: jid, value });
  return { doc: d, jid };
}

/** Instances + revolute j1 (z, value v1) + revolute/prismatic j2 + optional drive j1→j2. */
function coupled(
  ratio?: number,
  v1?: number,
  kind2 = 'revolute',
  axis2: unknown = 'y',
  extra: object = {},
): Record<'jid1' | 'jid2' | 'drid', string> & { doc: CadDocument } {
  const { doc: d0, idA, idB } = instances();
  const j1 = joint(d0, idA, idB, 'revolute', 'z', v1);
  const j2 = joint(j1.doc, idA, idB, kind2, axis2);
  const doc = ratio === undefined ? j2.doc : run(j2.doc, 'add_drive_relation', { driver: j1.jid, driven: j2.jid, ratio, ...extra });
  return { doc, jid1: j1.jid, jid2: j2.jid, drid: doc.driveRelationOrder[0]! };
}

describe('joints, drive relations, motion', () => {
  const { doc: idoc, idA, idB } = instances();
  const { doc: jdoc, jid } = joint(idoc, idA, idB, 'revolute', 'z');

  it.each([
    ['revolute', 'z'],
    ['prismatic', [0, 1, 0]],
  ])('add_joint %s creates a joint in jointOrder, purely', (kind, axis) => {
    const r = execute(idoc, 'add_joint', { kind, a: { instanceId: idA }, b: { instanceId: idB }, axis });
    expect(r.affected).toHaveLength(1);
    const j = r.affected[0]!;
    expect(r.document.joints[j]!.kind).toBe(kind);
    expect(r.document.jointOrder).toContain(j);
    expect(r.summary).toContain(j);
    if (kind === 'prismatic') expect((r.document.joints[j] as Extract<Joint, { kind: 'prismatic' }>).displacement).toBe(0);
    expectPure(idoc, () => execute(idoc, 'add_joint', { kind, a: { instanceId: idA }, b: { instanceId: idB }, axis }));
  });

  it.each<[string, () => object, string?]>([
    ['add_joint', () => ({ kind: 'revolute', a: { instanceId: 'ghost' }, b: { instanceId: idB }, axis: 'x' }), 'ghost'],
    ['add_joint', () => ({ kind: 'revolute', a: { instanceId: idA }, b: { instanceId: 'ghost' }, axis: 'y' }), 'ghost'],
    ['add_joint', () => ({ kind: 'weld', a: { instanceId: idA }, b: { instanceId: idB }, axis: 'z' })],
    ['add_joint', () => ({ kind: 'revolute', a: { instanceId: idA }, b: { instanceId: idB }, axis: 'diagonal' })],
    ['set_joint_value', () => ({ id: 'no-such-joint', value: 1 })],
    ['delete_joint', () => ({ id: 'ghost-joint' })],
    ['delete_drive_relation', () => ({ id: 'ghost-dr' })],
    ['add_drive_relation', () => ({ driver: jid, driven: jid, ratio: 1 }), 'same joint'],
    ['add_drive_relation', () => ({ driver: 'ghost', driven: jid, ratio: 1 })],
    ['motion_study', () => ({ mode: 'joint', target: 'ghost-joint', start: 0, end: Math.PI, steps: 5 }), 'ghost-joint'],
    ['motion_study', () => ({ mode: 'parameter', target: 'no_such_param', start: 0, end: 1 }), 'no_such_param'],
  ])('%s is a no-op (%#)', (name, p, summary) => expectNoOp(execute(jdoc, name, p()), jdoc, summary));

  it('set_joint_value takes numbers or parameter expressions', () => {
    const r = execute(jdoc, 'set_joint_value', { id: jid, value: Math.PI / 2 });
    expect(r.affected).toEqual([jid]);
    expect(r.document.joints[jid]).toMatchObject({ kind: 'revolute', angle: expect.closeTo(Math.PI / 2, 9) });
    const withParam = run(jdoc, 'set_parameter', { name: 'angle', expression: '1.5708' });
    const e = execute(withParam, 'set_joint_value', { id: jid, value: 'angle' });
    expect(e.affected).toEqual([jid]);
    expect((e.document.joints[jid] as Extract<Joint, { kind: 'revolute' }>).angle).toBeCloseTo(1.5708, 3);
  });

  it('drive relations: ratio propagates, cycles are rejected, delete_joint cascades, delete_drive_relation keeps joints', () => {
    const { doc, jid1, jid2, drid } = coupled(2, Math.PI / 2);
    expect(doc.driveRelations[drid]).toBeDefined();
    const ev = execute(doc, 'evaluate_motion', {});
    expect(ev.document).toBe(doc);
    expect((ev.data as { resolvedJoints: Record<string, number> }).resolvedJoints[jid2]).toBeCloseTo(Math.PI, 5);
    expectNoOp(execute(doc, 'add_drive_relation', { driver: jid2, driven: jid1, ratio: 1 }), doc, 'cycle');
    const del = execute(doc, 'delete_joint', { id: jid1 });
    expect([del.document.joints[jid1], del.document.driveRelations[drid]]).toEqual([undefined, undefined]);
    expect(del.document.jointOrder).not.toContain(jid1);
    expect(del.summary).toContain(drid);
    const dr = run(doc, 'delete_drive_relation', { id: drid });
    expect(dr.driveRelations[drid]).toBeUndefined();
    expect(dr.driveRelationOrder).not.toContain(drid);
    expect([!!dr.joints[jid1], !!dr.joints[jid2]]).toEqual([true, true]);
  });

  it('evaluate_motion / bake_motion: queries are pure, prismatic offsets move B, bake writes positions', () => {
    const doc = empty();
    const r = execute(doc, 'evaluate_motion', {});
    expectNoOp(r, doc);
    expect(r.data).toEqual(expect.objectContaining({ resolvedJoints: {}, instancePositions: {} }));
    expectNoOp(execute(doc, 'bake_motion', {}), doc);
    const rev = joint(idoc, idA, idB, 'revolute', 'z', Math.PI / 4).doc;
    expectPure(rev, () => expect(execute(rev, 'evaluate_motion', {}).document).toBe(rev));
    expectPure(rev, () => execute(rev, 'bake_motion', {}));
    const px = joint(idoc, idA, idB, 'prismatic', 'x', 5).doc;
    const pos = (execute(px, 'evaluate_motion', {}).data as { instancePositions: Record<string, number[]> }).instancePositions;
    expect(pos[idB]![0]).toBeCloseTo(5, 5);
    const baked = execute(joint(idoc, idA, idB, 'prismatic', 'y', 3).doc, 'bake_motion', {});
    expect(baked.affected).toContain(idB);
    expect(baked.document.entities[idB]!.position[1]).toBeCloseTo(3, 5);
  });

  it('round-trip save/load preserves joints and driveRelations', () => {
    const { doc, jid1, jid2, drid } = coupled(0.5, undefined, 'prismatic', 'x', { offset: 1 });
    const reloaded = run(empty(), 'load_document', { json: serializeDocument(doc) });
    expect([!!reloaded.joints[jid1], !!reloaded.joints[jid2]]).toEqual([true, true]);
    expect(reloaded.driveRelations[drid]).toMatchObject({ ratio: 0.5, offset: 1 });
    expect(reloaded.jointOrder).toContain(jid1);
    expect(reloaded.driveRelationOrder).toContain(drid);
  });

  describe('motion_study', () => {
    const doc0 = joint(idoc, idA, idB, 'revolute', 'z', 0);
    const study = (doc: CadDocument, p: object): { r: ReturnType<typeof execute>; data: MotionStudyData } => {
      const r = execute(doc, 'motion_study', p);
      return { r, data: r.data as MotionStudyData };
    };

    it('joint sweep: monotonic rotations and sweep values, pure', () => {
      const { doc, jid: j } = doc0;
      let res!: ReturnType<typeof study>;
      expectPure(doc, () => (res = study(doc, { mode: 'joint', target: j, start: Math.PI / 4, end: (3 * Math.PI) / 4, steps: 5 })));
      expectNoOp(res.r, doc);
      expect(res.data.steps).toHaveLength(5);
      for (const series of [
        res.data.steps.map((s) => (s.instanceRotations[idB] ?? [0, 0, 0])[2]!),
        res.data.steps.map((s) => s.sweepValue),
      ])
        for (let i = 1; i < series.length; i++) expect(series[i]!).toBeGreaterThan(series[i - 1]!);
      expectPure(doc, () =>
        expect(execute(doc, 'motion_study', { mode: 'joint', target: j, start: 0, end: Math.PI, steps: 8 }).document).toBe(doc),
      );
    });

    it('parameter sweep covers start..end', () => {
      const doc = run(doc0.doc, 'set_parameter', { name: 'angle', expression: '0' });
      const { r, data } = study(doc, { mode: 'parameter', target: 'angle', start: 0, end: Math.PI, steps: 4 });
      expectNoOp(r, doc);
      expect([data.steps.length, data.summary.totalSteps]).toEqual([4, 4]);
      expect(data.steps[0]!.sweepValue).toBeCloseTo(0);
      expect(data.steps[3]!.sweepValue).toBeCloseTo(Math.PI, 5);
    });

    it.each([
      [[0.5, 0, 0], [2, 2, 2], 0, 0.1, 3, true],
      [[0, 0, 0], [1, 1, 1], 500, 501, 5, false],
    ])('interference: B at %j (box %j) sweeping %d..%d → flagged %s', (at, size, start, end, steps, hit) => {
      const { doc: d, idA: a, idB: b } = instances(at, { size, position: [0, 0, 0] });
      const { doc, jid: j } = joint(d, a, b, 'prismatic', 'x', hit ? 0 : undefined);
      const { data } = study(doc, { mode: 'joint', target: j, start, end, steps, interferenceCheck: true });
      expect(data.interferences.length > 0).toBe(hit);
      expect(data.summary.framesWithInterference > 0).toBe(hit);
    });

    it('graceful failures: non-numeric parameter, steps=1, zero-length range', () => {
      const bad = run(empty(), 'set_parameter', { name: 'bad', expression: 'unknown_ref * 2' });
      expectNoOp(execute(bad, 'motion_study', { mode: 'parameter', target: 'bad', start: 0, end: 1 }), bad);
      const { doc, jid: j } = joint(idoc, idA, idB, 'revolute', 'z');
      for (const [p, summary] of [
        [{ start: 0, end: Math.PI, steps: 1 }, undefined],
        [{ start: 1.0, end: 1.0 }, 'zero length'],
      ] as const) {
        const { r, data } = study(doc, { mode: 'joint', target: j, ...p });
        expectNoOp(r, doc, summary);
        expect(data.steps).toHaveLength(0);
      }
    });
  });
});

type DimensionEntity = import('@core/model/types').DimensionEntity;

describe('add_dimension', () => {
  const doc = chain(
    ['draw_point', { position: [0, 0, 0] }],
    ['draw_point', { position: [10, 0, 0] }],
    ['draw_point', { position: [5, 5, 0] }],
    ['draw_arc', { center: [0, 0], radius: 5 }],
    ['draw_polyline', { points: xy(0, 0, 10, 0) }],
    ['draw_polyline', { points: xy(0, 5, 10, 5) }],
    ['draw_polyline', { points: xy(0, 0, 0, 10) }],
    ['draw_arc', { center: [0, 0], radius: 3, startAngle: 0, endAngle: Math.PI }],
    ['add_box', { size: [1, 1, 1] }],
    ['add_box', { size: [2, 2, 2] }],
  );
  const [p1, p2, p3, circle, line, line2, vline, arc, box1, box2] = doc.order as string[] & { length: 10 };
  const dim = (p: object): ReturnType<typeof execute> => execute(doc, 'add_dimension', p);

  it.each<[string, string[], Record<string, unknown>]>([
    ['linear', [p1!, p2!], { offset: 8 }],
    ['linear', [line!, line2!], {}],
    ['aligned', [p1!, p2!], {}],
    ['radial', [circle!], { label: 'R5' }],
    ['radial', [arc!], {}],
    ['angular', [p1!, p2!, p3!], { precision: 1 }],
    ['angular', [p1!, line!, vline!], {}],
    ['linear', [p1!, p2!], { offset: 12, precision: 2, label: '≈ 10 mm' }],
  ])('%s on %j creates a 2D dimension', (dimensionKind, entityIds, extra) => {
    const r = dim({ dimensionKind, entityIds, ...extra });
    expect(r.affected).toHaveLength(1);
    const e = first(r) as unknown as DimensionEntity;
    expect(e).toMatchObject({ kind: 'dimension', dimensionKind, entityIds, ...extra });
    expect(is2D(e)).toBe(true);
    expect(r.document.order).toContain(e.id);
    expect(r.summary).toContain(e.id);
    expect(r.summary).toContain(dimensionKind);
  });

  it.each<[string, string[], string?]>([
    ['diagonal', [p1!, p2!], 'diagonal'],
    ['linear', [p1!], '2'],
    ['radial', [circle!, p1!], '1'],
    ['angular', [p1!, p2!], '3'],
    ['linear', []],
    ['linear', [p1!, 'ghost-id'], 'ghost-id'],
    ['radial', [box1!], 'radial'],
    ['linear', [box1!, box2!], 'linear'],
    ['angular', [p1!, p2!, circle!], 'angular'],
  ])('%s on %j is a no-op', (dimensionKind, entityIds, summary) => expectNoOp(dim({ dimensionKind, entityIds }), doc, summary));

  it('is pure; scale_entity scales offset only; check_model flags dangling refs', () => {
    expectPure(doc, () => dim({ dimensionKind: 'linear', entityIds: [p1, p2] }));
    for (const [offset, factor, scaled] of [
      [10, 2, 20],
      [undefined, 3, undefined],
    ] as const) {
      const c = dim({ dimensionKind: 'linear', entityIds: [p1, p2], ...(offset === undefined ? {} : { offset }) });
      const r = execute(c.document, 'scale_entity', { id: c.affected[0], factor });
      expect(r.affected).toEqual(c.affected);
      expect(first(r)).toMatchObject({ entityIds: [p1, p2] });
      expect(first(r).offset).toBe(scaled);
      if (scaled) expect(r.summary).toContain('offset');
    }
    const withDim = run(doc, 'add_dimension', { dimensionKind: 'linear', entityIds: [p1, p2] });
    const dangling = (d: CadDocument): import('@core/commands/inspect/checkModel').CheckResult =>
      execute(d, 'check_model', {}).data as import('@core/commands/inspect/checkModel').CheckResult;
    expect(dangling(withDim).issues.filter((i) => i.code === 'dangling_dimension_ref')).toHaveLength(0);
    const broken = dangling(run(withDim, 'delete_entities', { ids: [p1] }));
    const issues = broken.issues.filter((i) => i.code === 'dangling_dimension_ref');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.message).toContain(p1);
    expect(broken.ok).toBe(false);
  });
});

describe('feature history', () => {
  const steps = (doc: CadDocument): string[] => doc.featureHistory.map((s) => s.name);
  const twoBoxes = chain(['add_box', { size: [1, 1, 1] }], ['add_box', { size: [2, 2, 2] }]);
  const [s0, s1] = twoBoxes.featureHistory.map((s) => s.id) as [string, string];

  it('mutating commands append steps; no-ops, read-only and parameter commands do not; purity', () => {
    expect(empty().featureHistory).toEqual([]);
    expect(twoBoxes.featureHistory.map((s) => [s.name, s.suppressed])).toEqual([
      ['add_box', false],
      ['add_box', false],
    ]);
    const doc = empty();
    expect(execute(doc, 'move_entities', { ids: ['ghost'], delta: [1, 0, 0] }).document).toBe(doc);
    const measured = execute(twoBoxes, 'measure_distance', { fromId: twoBoxes.order[0], toId: twoBoxes.order[1] });
    expect(measured.document).toBe(twoBoxes);
    let p = run(doc, 'set_parameter', { name: 'w', expression: '10' });
    expect([p.featureHistory.length, p.parameters['w']?.value]).toEqual([0, 10]);
    p = run(p, 'set_parameter', { name: 'w', expression: '20' });
    expect([p.featureHistory.length, p.parameters['w']?.value]).toEqual([0, 20]);
    p = run(p, 'delete_parameter', { name: 'w' });
    expect([p.featureHistory.length, p.parameters['w']]).toEqual([0, undefined]);
    expectPure(doc, () => execute(doc, 'add_box', { size: [1, 1, 1] }));
  });

  it.each<[string, object, string]>([
    ['replay_history', {}, 'empty'],
    ['set_step_suppressed', { stepId: 'ghost', suppressed: true }, 'ghost'],
    ['edit_step_params', { stepId: 'ghost', params: {} }, 'ghost'],
    ['reorder_step', { stepId: 'ghost', newIndex: 0 }, 'ghost'],
    ['delete_step', { stepId: 'ghost' }, 'ghost'],
    ['insert_step', { afterStepId: 'ghost', name: 'add_box', params: { size: [1, 1, 1] } }, 'ghost'],
  ])('%s on an empty/unknown target is a no-op', (name, p, summary) => {
    const doc = empty();
    expectNoOp(execute(doc, name, p), doc, summary);
  });

  it('replay_history regenerates every step without appending one', () => {
    const r = execute(twoBoxes, 'replay_history', {});
    expect(Object.keys(r.document.entities)).toHaveLength(2);
    expect(r.document.featureHistory).toHaveLength(2);
    expect(r.summary).toContain('2 step');
  });

  it('set_step_suppressed drops / restores the step entity without appending', () => {
    const r = execute(twoBoxes, 'set_step_suppressed', { stepId: s0, suppressed: true });
    expect(Object.keys(r.document.entities)).toHaveLength(1);
    expect(r.document.featureHistory.map((s) => s.suppressed)).toEqual([true, false]);
    const restored = run(r.document, 'set_step_suppressed', { stepId: s0, suppressed: false });
    expect(Object.keys(restored.entities)).toHaveLength(2);
    expect(restored.featureHistory[0]!.suppressed).toBe(false);
  });

  it('edit_step_params regenerates with new params without appending', () => {
    const r = execute(twoBoxes, 'edit_step_params', { stepId: s0, params: { size: [20, 20, 20] } });
    expect(Object.keys(r.document.entities)).toHaveLength(2);
    expect(r.document.entities[r.document.order[0]!]).toMatchObject({ size: [20, 20, 20] });
    expect(r.document.featureHistory[0]!.params).toEqual({ size: [20, 20, 20] });
    expect(r.document.featureHistory).toHaveLength(2);
  });

  it('reorder_step moves a step and regenerates; same index is a no-op', () => {
    const doc = chain(['add_box', { size: [1, 1, 1] }], ['add_cylinder', { radius: 2, height: 4 }]);
    const [a, b] = doc.featureHistory.map((s) => s.id);
    const r = execute(doc, 'reorder_step', { stepId: a, newIndex: 1 });
    expect(r.document.featureHistory.map((s) => s.id)).toEqual([b, a]);
    expect(Object.keys(r.document.entities)).toHaveLength(2);
    expectNoOp(execute(doc, 'reorder_step', { stepId: a, newIndex: 0 }), doc);
  });

  it('delete_step removes a step and its entity', () => {
    const r = execute(twoBoxes, 'delete_step', { stepId: s0 });
    expect(r.document.featureHistory.map((s) => s.id)).toEqual([s1]);
    expect(Object.keys(r.document.entities)).toHaveLength(1);
    expect(r.summary).toContain(s0);
  });

  it('insert_step appends or inserts after a step; unknown commands are kept but skipped', () => {
    const appended = run(twoBoxes, 'insert_step', { name: 'add_box', params: { size: [5, 5, 5] } });
    expect([appended.featureHistory.length, Object.keys(appended.entities).length]).toEqual([3, 3]);
    const inserted = run(twoBoxes, 'insert_step', { afterStepId: s0, name: 'add_sphere', params: { radius: 3 } });
    expect(steps(inserted)).toEqual(['add_box', 'add_sphere', 'add_box']);
    expect(Object.keys(inserted.entities)).toHaveLength(3);
    const unknown = run(empty(), 'insert_step', { name: 'nonexistent_command_xyz', params: {} });
    expect(steps(unknown)).toEqual(['nonexistent_command_xyz']);
    expect(unknown.entities).toEqual({});
  });

  it('suppressing the creating step makes a downstream move a silent no-op; history round-trips', () => {
    const doc = chain(['add_box', { size: [1, 1, 1], position: [0, 0, 0] }]);
    const moved = run(doc, 'move_entities', { ids: [doc.order[0]], delta: [5, 0, 0] });
    expect(moved.featureHistory).toHaveLength(2);
    expect(run(moved, 'set_step_suppressed', { stepId: moved.featureHistory[0]!.id, suppressed: true }).entities).toEqual({});
    expect(steps(deserializeDocument(serializeDocument(doc)))).toEqual(['add_box']);
  });
});

const STEEL = { name: 'steel', density: 0.00785, color: '#808080', metalness: 0.9, roughness: 0.3 };
const ALU = { name: 'aluminium', density: 0.0027, color: '#c0c0c0', metalness: 0.8, roughness: 0.2 };

describe('=expr params in replay_history', () => {
  const only = (doc: CadDocument): Loose => {
    expect(doc.order).toHaveLength(1);
    return doc.entities[doc.order[0]!] as Loose;
  };

  it('=expr step params follow parameter changes on replay (size and position)', () => {
    let doc = run(params(['side', '4'], ['xpos', '15']), 'insert_step', {
      name: 'add_box',
      params: { size: ['=side', '=side', '=side'], position: ['=xpos', 0, 0] },
      label: 'Parametric box',
    });
    expect(only(doc)).toMatchObject({ kind: 'box', size: [4, 4, 4], position: [15, 0, 0] });
    doc = run(run(doc, 'set_parameter', { name: 'side', expression: '8' }), 'set_parameter', { name: 'xpos', expression: '30' });
    const r = execute(doc, 'replay_history', {});
    expect(r.affected.length).toBeGreaterThan(0);
    expect(only(r.document)).toMatchObject({ kind: 'box', size: [8, 8, 8], position: [30, 0, 0] });
    expect(r.summary).toContain('replayed');
    expect(r.summary).not.toContain('Unresolved');
  });

  it('replay reproduces entities deterministically, purely; unresolved =expr is reported', () => {
    const doc = chain(['add_box', { size: [2, 3, 4] }], ['add_sphere', { radius: 5 }]);
    const r = execute(doc, 'replay_history', {});
    expect(
      Object.values(r.document.entities)
        .map((e) => e.kind)
        .sort(),
    ).toEqual(['box', 'sphere']);
    expectPure(doc, () => execute(doc, 'replay_history', {}));
    const bad = execute(run(empty(), 'insert_step', { name: 'add_box', params: { size: ['=nonexistent', 2, 2] } }), 'replay_history', {});
    expect(bad.summary).toContain('Unresolved');
    expect(bad.summary).toContain('nonexistent');
    expect(bad.document).toBeDefined();
  });

  it.each<[Record<string, unknown>, Record<string, number>, Record<string, unknown>, string[]?]>([
    [{ radius: 5 }, {}, { radius: 5 }],
    [{ label: 'hello' }, {}, { label: 'hello' }],
    [{ radius: '=r' }, { r: 7 }, { radius: 7 }],
    [{ size: '=width * 2' }, { width: 5 }, { size: 10 }],
    [{ position: ['=x', 0, '=z'] }, { x: 3, z: 7 }, { position: [3, 0, 7] }],
    [{ outer: { inner: '=val' } }, { val: 42 }, { outer: { inner: 42 } }],
    [{ flag: true, nothing: null }, {}, { flag: true, nothing: null }],
    [{ radius: '=missing_param' }, {}, { radius: '=missing_param' }, ['radius']],
    [{ size: '=width +' }, { width: 5 }, { size: '=width +' }, ['size']],
    [{ size: ['=a', '=b', '=c'] }, { a: 1 }, { size: [1, '=b', '=c'] }, ['size[1]', 'size[2]']],
  ])('resolveStepParams(%j, %j)', (input, env, resolved, errorPaths = []) => {
    const snapshot = JSON.stringify(input);
    const r = resolveStepParams(input, env);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(r.resolved).toEqual(resolved);
    expect(r.errors.map((e) => e.path).sort()).toEqual(errorPaths);
    if (input['radius'] === '=missing_param')
      expect(r.errors[0]).toMatchObject({ expression: '=missing_param', reason: expect.stringContaining('unknown parameter') });
  });

  it('buildParamEnv keeps only error-free parameters', () => {
    const env = buildParamEnv({
      width: { name: 'width', expression: '10', value: 10 },
      bad: { name: 'bad', expression: '=ghost', value: 0, error: 'unknown parameter: ghost' },
    });
    expect(env).toEqual({ width: 10 });
    expect(buildParamEnv({})).toEqual({});
  });
});

describe('configurations', () => {
  it('create_configuration stores and replaces by name, purely', () => {
    const doc = empty();
    const r = execute(doc, 'create_configuration', { name: 'small', parameterValues: { w: '10' } });
    expect(r.affected).toHaveLength(0);
    expect(r.document.configurations['small']).toMatchObject({ name: 'small', parameterValues: { w: '10' } });
    expect(r.summary).toContain('small');
    expect(r.summary).toContain('w');
    const replaced = run(r.document, 'create_configuration', { name: 'small', parameterValues: { w: '99' } });
    expect(replaced.configurations['small']!.parameterValues).toEqual({ w: '99' });
    expectPure(doc, () => execute(doc, 'create_configuration', { name: 'small', parameterValues: { w: '10' } }));
  });

  it.each([
    ['create_configuration', { name: '', parameterValues: { w: '10' } }, 'non-empty'],
    ['create_configuration', { name: 'bad', parameterValues: ['w', '10'] }, 'parameterValues'],
    ['create_configuration', { name: 'bad', parameterValues: { w: 42 } }, "parameterValues['w']"],
    ['activate_configuration', { name: 'ghost' }, 'ghost'],
    ['activate_configuration', { name: 'ghost' }, 'not found'],
    ['activate_configuration', { name: '' }, 'non-empty'],
  ])('%s %j is a no-op', (name, p, summary) => {
    const doc = empty();
    expectNoOp(execute(doc, name, p), doc, summary);
  });

  it('activate_configuration regenerates, updates parameters, keeps history, purely', () => {
    const doc = [
      ['create_configuration', { name: 'small', parameterValues: { w: '10' } }],
      ['create_configuration', { name: 'large', parameterValues: { w: '40' } }],
    ].reduce(
      (d, [n, p]) => run(d, n as string, p),
      run(params(['w', '5']), 'insert_step', { name: 'add_box', params: { size: ['=w', '=w', '=w'] } }),
    );
    for (const [name, w] of [
      ['small', 10],
      ['large', 40],
    ] as const) {
      const r = execute(doc, 'activate_configuration', { name });
      expect(Object.values(r.document.entities).map((e) => (e as Loose)['size'])).toEqual([[w, w, w]]);
      expect(r.summary).toContain(name);
      expect(r.document.parameters['w']).toMatchObject({ expression: String(w), value: w });
    }
    const boxed = run(run(doc, 'add_box', { size: [1, 1, 1] }), 'create_configuration', { name: 'v', parameterValues: { w: '20' } });
    expect(JSON.stringify(run(boxed, 'activate_configuration', { name: 'v' }).featureHistory)).toBe(JSON.stringify(boxed.featureHistory));
    expectPure(doc, () => execute(doc, 'activate_configuration', { name: 'large' }));
  });

  it('activate_configuration creates unknown parameters and notes them', () => {
    const r = execute(
      run(empty(), 'create_configuration', { name: 'test', parameterValues: { phantom: '99' } }),
      'activate_configuration',
      { name: 'test' },
    );
    expect(r.summary).toContain('phantom');
    expect(r.document.parameters['phantom']!.value).toBe(99);
  });

  it('configurations and materials round-trip through persistence', () => {
    const doc = run(
      run(run(empty(), 'create_configuration', { name: 'large', parameterValues: { w: '40', h: '20' } }), 'create_material', STEEL),
      'add_box',
      { size: [5, 5, 5] },
    );
    const id = doc.order[0]!;
    const loaded = deserializeDocument(serializeDocument(run(doc, 'assign_material', { materialName: 'steel', entityIds: [id] })));
    expect(loaded.configurations['large']!.parameterValues).toEqual({ w: '40', h: '20' });
    expect(loaded.materials['steel']!.density).toBe(0.00785);
    expect(loaded.entities[id]!.materialId).toBe('steel');
  });
});

describe('materials', () => {
  const withSteel = run(empty(), 'create_material', STEEL);
  const { doc: steelBoxes, ids } = ((): { doc: CadDocument; ids: string[] } => {
    const a = box(withSteel, [5, 5, 5]);
    const b = box(a.doc, [5, 5, 5]);
    return { doc: b.doc, ids: [a.id, b.id] };
  })();

  it('create_material adds or replaces, purely', () => {
    const doc = empty();
    const r = execute(doc, 'create_material', STEEL);
    expect(r.affected).toHaveLength(0);
    expect(r.document.materials['steel']).toMatchObject({ density: 0.00785, color: '#808080', metalness: 0.9, roughness: 0.3 });
    expect(r.summary).toContain('steel');
    expect(r.summary).toContain('created');
    const again = execute(r.document, 'create_material', { ...STEEL, density: 0.008, color: '#a0a0a0', metalness: 1.0, roughness: 0.2 });
    expect(again.document.materials['steel']!.density).toBe(0.008);
    expect(again.summary).toContain('replaced');
    expectPure(doc, () => execute(doc, 'create_material', STEEL));
  });

  it('create_material defaults the visual properties: neutral grey, or the replaced material values', () => {
    const plain = execute(empty(), 'create_material', { name: 'pla', density: 0.00124 });
    expect(plain.document.materials['pla']).toMatchObject({ color: '#b0b0b0', metalness: 0, roughness: 0.5 });
    const steel = run(empty(), 'create_material', STEEL);
    const denser = execute(steel, 'create_material', { name: 'steel', density: 0.0079 });
    expect(denser.document.materials['steel']).toMatchObject({ density: 0.0079, color: '#808080', metalness: 0.9, roughness: 0.3 });
  });

  it.each<[object, string?]>([
    [{ name: '' }, 'non-empty'],
    [{ name: 'bad', density: -1 }, 'density'],
    [{ name: 'bad', density: 0 }],
    [{ name: 'bad', metalness: 1.5 }, 'metalness'],
    [{ name: 'bad', roughness: -0.1 }, 'roughness'],
    [{ name: 'bad', color: 'not-a-color' }, 'color'],
    [{ name: 'bad', color: '#abc' }, 'color'],
  ])('create_material %j is a no-op', (p, summary) => {
    const doc = empty();
    expectNoOp(execute(doc, 'create_material', { ...STEEL, ...p }), doc, summary);
  });

  it('assign_material assigns one or many, skipping unknown ids, purely', () => {
    const one = execute(run(steelBoxes, 'create_material', ALU), 'assign_material', { materialName: 'aluminium', entityIds: [ids[0]] });
    expect(one.affected).toEqual([ids[0]]);
    expect(one.document.entities[ids[0]!]!.materialId).toBe('aluminium');
    expect(one.summary).toContain('aluminium');
    expect(one.summary).toContain(ids[0]);
    const both = execute(steelBoxes, 'assign_material', { materialName: 'steel', entityIds: ids });
    expect(ids.map((id) => both.document.entities[id]!.materialId)).toEqual(['steel', 'steel']);
    const partial = execute(steelBoxes, 'assign_material', { materialName: 'steel', entityIds: [ids[0], 'ghost-id'] });
    expect(partial.affected).toEqual([ids[0]]);
    expect(partial.document.entities[ids[0]!]!.materialId).toBe('steel');
    expect(partial.summary).toContain('ghost-id');
    expectPure(steelBoxes, () => execute(steelBoxes, 'assign_material', { materialName: 'steel', entityIds: [ids[0]] }));
  });

  it.each<[object, string[]]>([
    [{ materialName: 'nonexistent', entityIds: ['$0'] }, ['nonexistent', 'not found']],
    [{ materialName: 'steel', entityIds: ['ghost-1', 'ghost-2'] }, ['ghost-1']],
    [{ materialName: 'steel', entityIds: [] }, []],
    [{ materialName: '', entityIds: ['anything'] }, []],
  ])('assign_material %j is a no-op', (p, summary) => {
    const r = execute(steelBoxes, 'assign_material', JSON.parse(JSON.stringify(p).replace('$0', ids[0]!)));
    expectNoOp(r, steelBoxes);
    for (const s of summary) expect(r.summary).toContain(s);
  });

  it('mass_properties uses the assigned material density, else the density param (still validated)', () => {
    const doc = [
      { materialName: 'steel', entityIds: [ids[0]] },
      { materialName: 'aluminium', entityIds: [ids[1]] },
    ].reduce((d, p) => run(d, 'assign_material', p), run(steelBoxes, 'create_material', ALU));
    const [steel, alu] = ids.map((entityId) => execute(doc, 'mass_properties', { entityId, density: 1 })) as [
      ReturnType<typeof execute>,
      ReturnType<typeof execute>,
    ];
    type Mass = { mass: number; density: number; volume: number };
    const [s, a] = [steel.data as Mass, alu.data as Mass];
    expect(s.volume).toBeCloseTo(a.volume, 6);
    expect([s.density, a.density]).toEqual([0.00785, 0.0027]);
    expect(s.mass / a.mass).toBeCloseTo(0.00785 / 0.0027, 4);
    expect(s.mass).toBeGreaterThan(a.mass);
    expect(steel.summary).toContain("material 'steel'");
    expect(alu.summary).toContain("material 'aluminium'");
    expectNoOp(execute(doc, 'mass_properties', { entityId: ids[0], density: -1 }), doc, 'density');
    const plain = box(empty(), [10, 10, 10]);
    const r = execute(plain.doc, 'mass_properties', { entityId: plain.id, density: 0.00785 });
    expect(r.data).toMatchObject({ density: 0.00785, mass: expect.closeTo(1000 * 0.00785, 6) });
    expect(r.summary).toContain('param');
  });

  it('toToolSchemas maps 1:1 onto listCommands', () => expect(toToolSchemas().length).toBe(listCommands().length));
});

describe('replayHistory id-remapping', () => {
  const replayed = (doc: CadDocument): Loose[] => Object.values(run(doc, 'replay_history', {}).entities) as Loose[];

  it('move, assign_material and delete steps survive replay', () => {
    let doc = run(empty(), 'create_material', ALU);
    const a = add(doc, 'add_box', { size: [4, 4, 4], position: [0, 0, 0] });
    const b = add(a.doc, 'add_box', { size: [1, 1, 1], position: [10, 0, 0] });
    doc = [
      ['move_entities', { ids: [a.id], delta: [3, 3, 0] }],
      ['assign_material', { materialName: 'aluminium', entityIds: [a.id] }],
      ['delete_entities', { ids: [b.id] }],
    ].reduce((d, [n, p]) => run(d, n as string, p), b.doc);
    expect(Object.keys(doc.entities)).toEqual([a.id]);
    expect(doc.entities[a.id]).toMatchObject({ position: [3, 3, 0], materialId: 'aluminium' });
    expect(replayed(doc)).toEqual([expect.objectContaining({ kind: 'box', position: [3, 3, 0], materialId: 'aluminium' })]);
  });

  it('multi-id producers: moved duplicate / Nth array copy survive replay', () => {
    const o = add(empty(), 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });
    const dup = add(o.doc, 'duplicate_entities', { ids: [o.id], offset: [5, 0, 0] });
    const doc = run(dup.doc, 'move_entities', { ids: [dup.id], delta: [0, 3, 0] });
    expect(doc.entities[dup.id]!.position).toEqual([5, 3, 0]);
    const ents = replayed(doc);
    expect(ents).toHaveLength(2);
    expect(ents.find((e) => e.position[1] === 3)?.position).toEqual([5, 3, 0]);
    const arr = execute(o.doc, 'array_linear', { id: o.id, count: 3, offset: [5, 0, 0] });
    expect(arr.affected.length).toBeGreaterThanOrEqual(2);
    const moved = run(arr.document, 'move_entities', { ids: [arr.affected[1]], delta: [0, 7, 0] });
    expect(moved.entities[arr.affected[1]!]!.position[1]).toBe(7);
    const again = replayed(moved);
    expect(again.filter((e) => e.position[1] === 7)).toHaveLength(1);
    expect(again).toHaveLength(Object.keys(moved.entities).length);
  });

  it('steps without `affected` (old docs) replay without throwing', () => {
    const doc = chain(['add_box', { size: [2, 2, 2] }], ['add_sphere', { radius: 3 }]);
    const featureHistory = doc.featureHistory.map(({ affected: _affected, ...rest }) => rest);
    expect(replayed({ ...doc, featureHistory } as CadDocument)).toHaveLength(2);
  });

  it('remapIds replaces mapped ids (incl. arrays), keeps others, never mutates, fast-paths an empty map', () => {
    const idMap = new Map([
      ['old-1', 'new-1'],
      ['a', 'x'],
      ['b', 'y'],
    ]);
    const p = { id: 'old-1', size: [1, 1, 1], label: 'some-label', entityIds: ['a', 'b', 'c'], nested: { ref: 'old-1' } };
    const snapshot = JSON.stringify(p);
    expect(remapIds(p, idMap)).toEqual({ ...p, id: 'new-1', entityIds: ['x', 'y', 'c'], nested: { ref: 'new-1' } });
    expect(JSON.stringify(p)).toBe(snapshot);
    expect(remapIds(p, new Map())).toBe(p);
  });

  it('execute() stores result.affected on each FeatureStep', () => {
    const r = execute(empty(), 'add_box', { size: [1, 1, 1] });
    expect(r.document.featureHistory[0]!.affected).toEqual(r.affected);
    const id = r.affected[0]!;
    const moved = run(r.document, 'move_entities', { ids: [id], delta: [1, 0, 0] }).featureHistory[1]!;
    expect([moved.name, moved.affected]).toEqual(['move_entities', [id]]);
  });
});

type StlData = { format: string; triangleCount: number; stl?: string; stlBase64?: string };
const stl = (doc: CadDocument, p: object = {}): StlData => execute(doc, 'export_stl', p).data as StlData;
const stlBytes = (doc: CadDocument, p: object = {}): DataView => {
  const b = Buffer.from(stl(doc, { format: 'binary', ...p }).stlBase64!, 'base64');
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
};

describe('export_stl', () => {
  it('ASCII STL for a box: 12 facets, 36 vertices, read-only and pure', () => {
    const doc = chain(['add_box', { size: [2, 2, 2] }]);
    const r = execute(doc, 'export_stl', { format: 'ascii' });
    expectNoOp(r, doc);
    const data = r.data as StlData;
    expect([data.format, data.triangleCount]).toEqual(['ascii', 12]);
    expect(data.stl!.startsWith('solid ')).toBe(true);
    expect(data.stl!.endsWith('endsolid llull')).toBe(true);
    expect(data.stl!.match(/^\s*facet normal/gm)).toHaveLength(12);
    expect(data.stl!.match(/^\s*vertex /gm)).toHaveLength(36);
    expectPure(doc, () => [execute(doc, 'export_stl', { format: 'ascii' }), execute(doc, 'export_stl', { format: 'binary' })]);
    const named = stl(doc, { name: 'my_part' }).stl!;
    expect(named.startsWith('solid my_part')).toBe(true);
    expect(named.endsWith('endsolid my_part')).toBe(true);
    const schema = toToolSchemas().find((s) => s.name === 'export_stl');
    expect(schema?.annotations?.readOnlyHint).toBe(true);
  });

  it.each<[string, object]>([
    ['add_cylinder', { radius: 1, height: 2 }],
    ['add_sphere', { radius: 1 }],
    ['extrude_profile', { profile: xy(0, 0, 2, 0, 2, 2, 0, 2), depth: 1 }],
    ['add_cone', { radius: 1, height: 2 }],
    ['add_torus', { ringRadius: 2, tubeRadius: 0.5 }],
    ['add_wedge', { size: [2, 1, 3] }],
    ['add_pyramid', { baseWidth: 2, baseDepth: 2, height: 3 }],
  ])('%s exports a well-formed, non-empty solid', (name, p) => {
    const data = stl(run(empty(), name, p));
    expect(data.triangleCount).toBeGreaterThan(0);
    expect(data.stl!.split('facet normal').length - 1).toBe(data.triangleCount);
    expect(data.stl).toContain('solid llull');
    expect(data.stl).toContain('endsolid llull');
  });

  it('a boolean-union mesh exports triangles when the union yields a mesh', () => {
    const { doc, ids } = boxes(1);
    const b = add(doc, 'add_box', { size: [2, 2, 2], position: [1, 0, 0] });
    const u = execute(b.doc, 'boolean', { op: 'union', entityIds: [ids[0], b.id] });
    if (u.affected.length > 0 && first(u).kind === 'mesh') expect(stl(u.document).triangleCount).toBeGreaterThan(0);
  });

  it('bakes the world transform (position, rotation) into vertices', () => {
    const xs = [
      ...stl(chain(['add_box', { size: [2, 2, 2], position: [10, 0, 0] }]), { format: 'ascii' }).stl!.matchAll(/vertex\s+(\S+)/g),
    ].map((m) => parseFloat(m[1]!));
    expect(xs.length).toBeGreaterThan(0);
    for (const x of xs) expect(x >= 9 - 1e-5 && x <= 11 + 1e-5).toBe(true);
    const a = add(empty(), 'add_box', { size: [2, 1, 1], position: [0, 0, 0] });
    const rotated = stl(run(a.doc, 'rotate_entity', { id: a.id, delta: [0, 0, Math.PI / 4] }), { format: 'ascii' });
    expect(stl(a.doc, { format: 'ascii' }).stl).not.toBe(rotated.stl);
    expect(rotated.triangleCount).toBe(12);
  });

  it('entityIds selects a subset; default exports every 3D entity', () => {
    const { doc, id } = box();
    expect(stl(run(doc, 'add_sphere', { radius: 2 }), { entityIds: [id] }).triangleCount).toBe(12);
    expect(stl(boxes(2).doc).triangleCount).toBe(24);
  });

  it('binary STL: 84 + 50n bytes, count at 80, name header, little-endian vertices', () => {
    const doc = chain(['add_box', { size: [2, 2, 2], position: [0, 0, 0] }]);
    const data = stl(doc, { format: 'binary' });
    expect([data.format, data.triangleCount]).toEqual(['binary', 12]);
    const view = stlBytes(doc);
    expect(view.byteLength).toBe(84 + 50 * 12);
    expect(view.getUint32(80, true)).toBe(12);
    const named = stlBytes(doc, { name: 'widget' });
    expect(String.fromCharCode(...new Uint8Array(named.buffer, named.byteOffset, 6))).toBe('widget');
    for (const o of [12, 16, 20]) expect(Math.abs(view.getFloat32(84 + o, true))).toBeCloseTo(1, 5);
  });

  it('2D-only, unknown and empty selections yield an empty, well-formed solid', () => {
    const doc = chain(['draw_polyline', { points: xy(0, 0, 5, 5) }], ['draw_arc', { center: [0, 0], radius: 3 }]);
    const r = execute(doc, 'export_stl', {});
    expectNoOp(r, doc);
    expect((r.data as StlData).triangleCount).toBe(0);
    expect((r.data as StlData).stl).toContain('endsolid');
    const skipped = execute(doc, 'export_stl', { entityIds: [doc.order[0]] });
    expect((skipped.data as StlData).triangleCount).toBe(0);
    expect(skipped.summary).toContain('skipped');
    const e = empty();
    const ghost = execute(e, 'export_stl', { entityIds: ['ghost-id'] });
    expectNoOp(ghost, e, 'ghost-id');
    expect((ghost.data as StlData).triangleCount).toBe(0);
    expect(stl(e).triangleCount).toBe(0);
  });
});

describe('recipes', () => {
  const recipeOf = (...steps: Array<[string, object]>): CadDocument => ({
    ...empty(),
    recipes: run(chain(...steps), 'save_recipe', { name: 'r' }).recipes,
  });

  it('save_recipe snapshots featureHistory (label, empty note, replace), purely, as a deep copy', () => {
    const doc = chain(['add_box', { size: [2, 2, 2] }], ['add_sphere', { radius: 1 }]);
    const r = execute(doc, 'save_recipe', { name: 'my_bracket', label: 'A simple box recipe' });
    expect(r.affected).toHaveLength(0);
    expect(r.document.recipes['my_bracket']).toMatchObject({ name: 'my_bracket', label: 'A simple box recipe', steps: [{}, {}] });
    expect(r.summary).toContain('my_bracket');
    expect(r.summary).toContain('2 step');
    const e = execute(empty(), 'save_recipe', { name: 'empty_recipe' });
    expect(e.document.recipes['empty_recipe']!.steps).toHaveLength(0);
    expect(e.summary).toContain('empty');
    const one = run(chain(['add_box', { size: [1, 1, 1] }]), 'save_recipe', { name: 'r' });
    expect(one.recipes['r']!.steps).toHaveLength(1);
    const grown = run(one, 'add_sphere', { radius: 2 });
    expect(one.recipes['r']!.steps).toHaveLength(1);
    expect(run(grown, 'save_recipe', { name: 'r' }).recipes['r']!.steps).toHaveLength(2);
    expectPure(doc, () => execute(doc, 'save_recipe', { name: 'purity_check' }));
  });

  it.each([
    ['save_recipe', { name: '' }, 'failed'],
    ['save_recipe', { name: '   ' }, ''],
    ['instantiate_recipe', { name: 'does_not_exist' }, 'does_not_exist'],
    ['instantiate_recipe', { name: 'does_not_exist' }, 'not found'],
    ['instantiate_recipe', { name: '' }, ''],
  ])('%s %j is a no-op', (name, p, summary) => {
    const doc = empty();
    expectNoOp(execute(doc, name, p), doc, summary);
  });

  it('instantiate_recipe adds fresh ids, remaps step ids, is additive, repeatable, one history step, pure', () => {
    const one = recipeOf(['add_box', { size: [3, 3, 3] }]);
    const r = execute(one, 'instantiate_recipe', { name: 'r' });
    expectSingleEntity(r, 'box');
    expect(r.summary).toContain('1 step');
    expect(r.document.featureHistory.map((s) => s.name)).toEqual(['instantiate_recipe']);
    const twice = run(r.document, 'instantiate_recipe', { name: 'r' });
    expect(new Set(twice.order).size).toBe(2);
    const sphere = run(one, 'add_sphere', { radius: 2 });
    const additive = run(sphere, 'instantiate_recipe', { name: 'r' });
    expect(additive.order).toHaveLength(2);
    expect(additive.entities[sphere.order[0]!]!.kind).toBe('sphere');
    expectPure(one, () => execute(one, 'instantiate_recipe', { name: 'r' }));
    const b = box();
    const moved = execute(
      recipeOf(['add_box', { size: [1, 1, 1] }], ['move_entities', { ids: [b.id], delta: [5, 0, 0] }]),
      'instantiate_recipe',
      { name: 'r' },
    );
    expect(moved.affected).toHaveLength(1);
    expect(first(moved).position).toEqual([5, 0, 0]);
  });

  it('instantiated entities survive replay_history; recipes survive persistence', () => {
    const inst = run(recipeOf(['add_box', { size: [2, 2, 2] }], ['add_sphere', { radius: 1 }]), 'instantiate_recipe', { name: 'r' });
    expect([inst.order.length, inst.featureHistory.length]).toEqual([2, 1]);
    const replayed = execute(inst, 'replay_history', {});
    expect(replayed.document.order).toHaveLength(2);
    expect(replayed.summary).toContain('2 entit');
    const loaded = deserializeDocument(serializeDocument(recipeOf(['add_box', { size: [1, 1, 1] }])));
    expect(Object.keys(loaded.recipes)).toEqual(['r']);
    expect(loaded.recipes['r']!.steps).toHaveLength(1);
    const schemas = toToolSchemas();
    expect(schemas.find((s) => s.name === 'save_recipe')?.annotations?.idempotentHint).toBe(true);
    expect(schemas.find((s) => s.name === 'instantiate_recipe')?.annotations?.idempotentHint).toBeUndefined();
  });
});

const closeVec = (actual: readonly number[], expected: readonly number[]): void => {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((v, i) => expect(actual[i]!).toBeCloseTo(v, 9));
};
const RECT = xy(0, 0, 4, 0, 4, 3, 0, 3);

describe('rotation at creation and AABB summaries', () => {
  it.each<[string, object, number[], unknown]>([
    ['add_box', { size: [2, 4, 6], position: [1, 2, 3] }, [0.1, 0.2, 0.3], [Infinity, 0, 0]],
    ['add_box', { size: [2, 2, 2] }, [0, 0, 0.5], [0.5, 0.5]],
    ['add_cylinder', { radius: 3, height: 5 }, [0, 0, Math.PI / 2], 'bad'],
    ['add_sphere', { radius: 5 }, [Math.PI, 0, 0], [NaN, 0, 0]],
    ['add_cone', { radius: 2, height: 5 }, [0, Math.PI / 4, 0], [0, 0, 0, 0]],
    ['add_torus', { ringRadius: 5, tubeRadius: 1 }, [0.5, 0, 0], [0, NaN, 0]],
    ['add_wedge', { size: [4, 3, 5], position: [1, 0, 0] }, [0, 0, Math.PI], null],
    ['add_pyramid', { baseWidth: 4, baseDepth: 3, height: 5 }, [Math.PI / 6, 0, 0], [Infinity, Infinity, Infinity]],
    ['extrude_profile', { profile: RECT, depth: 5 }, [0, Math.PI / 3, 0], [0, Infinity, 0]],
  ])('%s stores rotation, ignores malformed rotation %#, reports a world AABB', (name, p, rotation, bad) => {
    const r = execute(empty(), name, { ...p, rotation });
    closeVec(first(r).rotation, rotation);
    expect(r.summary).toContain('world AABB');
    expect(first(execute(empty(), name, p)).rotation).toEqual([0, 0, 0]);
    const ignored = execute(empty(), name, { ...p, rotation: bad });
    expect(ignored.affected).toHaveLength(1);
    expect(first(ignored).rotation).toEqual([0, 0, 0]);
  });

  it.each([
    [{ profile: xy(0, 0, 1, 0), depth: 4 }, /at least 3/i],
    [{ profile: xy(0, 0, 2, 0, 1, 2), depth: 0 }, /> 0/],
  ])('extrude_profile %j is a no-op', (p, summary) => {
    const doc = empty();
    const r = execute(doc, 'extrude_profile', p);
    expectNoOp(r, doc);
    expect(r.summary).toMatch(summary);
  });

  it('add_box summary lists AABB min and max', () => {
    const s = execute(empty(), 'add_box', { size: [2, 4, 6], position: [1, 2, 3] }).summary;
    for (const t of ['world AABB', 'min', 'max']) expect(s).toContain(t);
  });
});

describe('unified placement anchor', () => {
  const bounds = (name: string, p: object): { e: Entity; min: readonly number[]; max: readonly number[] } => {
    const r = execute(empty(), name, p);
    expect(r.affected).toHaveLength(1);
    const e = first(r);
    return { e, ...entityBounds(e) };
  };

  it.each<[string, object, number[], number[]?]>([
    ['add_box', { size: [2, 4, 6], position: [5, 6, 7] }, [5, 6, 7]],
    ['add_cylinder', { radius: 1, height: 4, position: [1, 2, 3] }, [1, 2, 3]],
    ['add_sphere', { radius: 2, position: [1, 2, 3] }, [1, 2, 3]],
    ['add_torus', { ringRadius: 3, tubeRadius: 1, position: [1, 1, 1] }, [1, 1, 1]],
    ['add_cone', { radius: 1, height: 4, position: [0, 0, 4] }, [0, 0, 4], [-1, -1, 4]],
    ['add_pyramid', { baseWidth: 2, baseDepth: 2, height: 2, position: [0, 0, 3] }, [0, 0, 3], [-1, -1, 3]],
    ['add_wedge', { size: [2, 2, 2], position: [2, 2, 2] }, [2, 2, 2], [2, 2, 2]],
    ['add_box', { size: [2, 2, 2], position: [3, 3, 3], anchor: 'garbage' }, [3, 3, 3]],
    ['add_box', { size: [2, 2, 2], position: [3, 3, 3], anchor: 123 }, [3, 3, 3]],
  ])('%s keeps its default anchor (%j)', (name, p, position, min) => {
    const b = bounds(name, p);
    closeVec(b.e.position, position);
    if (min) expect(b.min[2]).toBeCloseTo(min[2]!, 9);
    if (name === 'add_wedge') closeVec(b.min, min!);
  });

  it.each<[string, object, number[] | null, number[] | null, [number, number]?]>([
    ['add_box', { size: [2, 4, 6], anchor: 'min' }, [0, 0, 0], [2, 4, 6]],
    ['add_box', { size: [2, 2, 2], position: [1, 1, 0], anchor: 'base-center' }, [0, 0, 0], [2, 2, 2]],
    ['add_cylinder', { radius: 1, height: 4, anchor: 'min' }, [0, 0, 0], [2, 2, 4]],
    ['add_sphere', { radius: 1, anchor: 'min' }, [0, 0, 0], [2, 2, 2]],
    ['add_cone', { radius: 1, height: 4, anchor: 'center' }, null, null, [-2, 2]],
    ['add_pyramid', { baseWidth: 2, baseDepth: 2, height: 2, anchor: 'min' }, [0, 0, 0], null],
    ['add_wedge', { size: [2, 2, 2], anchor: 'center' }, [-1, -1, -1], [1, 1, 1]],
  ])('%s %j places that AABB point at position', (name, p, min, max, z) => {
    const b = bounds(name, { position: [0, 0, 0], ...p });
    if (min) closeVec(b.min, min);
    if (max) closeVec(b.max, max);
    if (z) closeVec([b.min[2]!, b.max[2]!], z);
  });

  it('is pure', () => {
    const doc = empty();
    expectPure(doc, () => execute(doc, 'add_box', { size: [2, 2, 2], position: [1, 1, 1], anchor: 'min' }));
  });
});

describe('clear_document', () => {
  it('clears entities, order, selection, groups; resets or keeps layers; keeps units and camera; reports counts; pure', () => {
    const doc = chain(
      ['set_units', { units: 'cm' }],
      ['add_layer', { name: 'Extra' }],
      ['add_box', { size: [1, 1, 1] }],
      ['add_cylinder', { radius: 1, height: 2 }],
      ['add_box', { size: [1, 1, 1] }],
    );
    expect(Object.keys(doc.layers)).toHaveLength(2);
    const r = execute(doc, 'clear_document', {});
    expect(r.affected).toHaveLength(0);
    expect([r.document.entities, r.document.order, r.document.selection, r.document.groups]).toEqual([{}, [], [], {}]);
    expect([Object.keys(r.document.layers).length, r.document.layerOrder.length]).toEqual([1, 1]);
    expect([r.document.units, r.document.camera]).toEqual(['cm', doc.camera]);
    expect(r.summary).toContain('3');
    expect(r.summary).toContain('cm');
    const kept = execute(doc, 'clear_document', { keepLayers: true });
    expect(kept.affected).toHaveLength(0);
    expect(kept.document.entities).toEqual({});
    expect([Object.keys(kept.document.layers).length, kept.document.layerOrder.length]).toEqual([2, 2]);
    expectPure(doc, () => execute(doc, 'clear_document', {}));
    const e = empty();
    expectNoOp(execute(e, 'clear_document', {}), e, 'already empty');
    const schema = toToolSchemas().find((s) => s.name === 'clear_document');
    expect(schema!.description).toBeTruthy();
    expect(schema!.annotations?.destructiveHint).toBe(true);
  });
});

const unitBox = chain(['add_box', { size: [1, 1, 1] }]);

describe('set_camera', () => {
  it.each<[object, Record<string, unknown>, string?]>([
    [
      { target: [1, 2, 3], azimuth: 0.5, polar: 1.0, distance: 20 },
      { target: [1, 2, 3], azimuth: 0.5, polar: 1.0, distance: 20 },
      'target',
    ],
    [{ azimuth: 1.2 }, { azimuth: 1.2 }],
    [{ target: [5, 10, 0] }, { target: [5, 10, 0] }],
    [
      { target: [0, 0, 0], azimuth: 1.57, polar: 0.8 },
      { azimuth: 1.57, polar: 0.8 },
    ],
    [{ distance: 15 }, { distance: 15 }],
  ])('%j sets those fields, keeps the rest, appends no history, purely', (p, set, summary) => {
    const doc = empty();
    const r = execute(doc, 'set_camera', p);
    expect(r.affected).toHaveLength(0);
    expect(r.document).not.toBe(doc);
    expect(r.document.camera).toEqual({ ...doc.camera, ...set });
    expect(r.document.featureHistory).toHaveLength(0);
    if (summary) expect(r.summary).toContain(summary);
    expectPure(doc, () => execute(doc, 'set_camera', p));
  });

  it.each([
    [{ distance: 0 }, 'distance'],
    [{}, 'no fields'],
    [{ target: [1, 2] }, ''],
    [{ target: [1, Infinity, 0] }, ''],
  ])('%j is a no-op', (p, summary) => {
    const doc = empty();
    expectNoOp(execute(doc, 'set_camera', p), doc, summary);
  });

  it('tool schema is idempotent with an optional target', () => {
    const schema = toToolSchemas().find((s) => s.name === 'set_camera')!;
    expect(schema.annotations?.idempotentHint).toBe(true);
    expect(schema.input_schema.required ?? []).not.toContain('target');
  });
});

describe('fit_view', () => {
  const cam = (doc: CadDocument, p: object): CadDocument['camera'] => run(doc, 'fit_view', p).camera;
  const eye = ({ azimuth, polar }: { azimuth: number; polar: number }): number[] => [
    Math.sin(polar) * Math.sin(azimuth),
    Math.sin(polar) * Math.cos(azimuth),
    Math.cos(polar),
  ];

  it('frames the scene centre at distance > 0, appends no history, purely', () => {
    const doc = chain(['add_box', { size: [2, 2, 2], position: [0, 0, 0] }]);
    const r = execute(doc, 'fit_view', { direction: 'iso' });
    expect(r.affected).toHaveLength(0);
    expect(r.document).not.toBe(doc);
    expect(r.document.camera.distance).toBeGreaterThan(0);
    for (const t of r.document.camera.target) expect(t).toBeCloseTo(0, 3);
    expect(r.summary).toContain('iso');
    expect(r.document.featureHistory.map((s) => s.name)).toEqual(['add_box']);
    expect(cam(doc, { direction: 'iso', padding: 2.0 }).distance).toBeCloseTo(cam(doc, { direction: 'iso', padding: 1.0 }).distance * 2, 5);
    expectPure(doc, () => execute(doc, 'fit_view', {}));
  });

  it('presets put the eye on the Z-up CAD side; current keeps angles; default camera is unmirrored', () => {
    expect(cam(unitBox, { direction: 'front' })).toMatchObject({
      azimuth: expect.closeTo(Math.PI, 5),
      polar: expect.closeTo(Math.PI / 2, 5),
    });
    expect(cam(unitBox, { direction: 'top' }).polar).toBeCloseTo(0.01, 5);
    const at = (direction: string): number[] => eye(cam(unitBox, { direction }));
    expect(at('front')[1]).toBeLessThan(-0.99);
    expect(at('back')[1]).toBeGreaterThan(0.99);
    expect(at('right')[0]).toBeGreaterThan(0.99);
    expect(at('left')[0]).toBeLessThan(-0.99);
    expect(at('top')[2]).toBeGreaterThan(0.99);
    expect(at('top')[1]).toBeLessThan(0);
    for (const e of [at('iso'), eye(empty().camera)]) expect(e.map(Math.sign)).toEqual([1, -1, 1]);
    const current = cam(run(run(empty(), 'set_camera', { azimuth: 1.1, polar: 0.7 }), 'add_box', { size: [3, 3, 3] }), {
      direction: 'current',
    });
    expect(current).toMatchObject({ azimuth: expect.closeTo(1.1, 5), polar: expect.closeTo(0.7, 5) });
    expect(current.distance).toBeGreaterThan(0);
  });

  it('an empty document falls back to default framing', () => {
    const doc = empty();
    const r = execute(doc, 'fit_view', { direction: 'front' });
    expect(r.document).not.toBe(doc);
    expect(r.document.camera).toMatchObject({ distance: 10, target: [0, 0, 0] });
    expect(r.summary).toContain('empty');
  });

  it.each([
    [{ direction: 'diagonal' }, 'diagonal'],
    [{ padding: 0 }, 'padding'],
  ])('%j is a no-op', (p, summary) => {
    const doc = empty();
    expectNoOp(execute(doc, 'fit_view', p), doc, summary);
  });

  it('tool schema lists every direction', () => {
    const dir = toToolSchemas().find((s) => s.name === 'fit_view')!.input_schema.properties['direction'];
    expect(dir!.enum).toEqual(expect.arrayContaining(['front', 'back', 'left', 'right', 'top', 'bottom', 'iso', 'current']));
  });
});

type ObjData = { format: string; text: string; triangleCount: number };
type GltfData = { format: string; triangleCount: number; text?: string; base64?: string };
const revolved = (segments: number): CadDocument =>
  chain(['revolve_profile', { profile: xy(1, 0, 2, 0, 2, 1, 1, 1), axis: 'z', angle: Math.PI * 2, segments }]);

describe('export_obj / export_gltf', () => {
  const boxDoc2 = chain(['add_box', { size: [2, 2, 2] }]);
  const glb = (doc: CadDocument): { data: GltfData; view: DataView } => {
    const data = execute(doc, 'export_gltf', { binary: true }).data as GltfData;
    const b = Buffer.from(data.base64!, 'base64');
    return { data, view: new DataView(b.buffer, b.byteOffset, b.byteLength) };
  };

  it.each(['export_obj', 'export_gltf'])('%s is read-only, pure, and flagged readOnlyHint', (name) => {
    const r = execute(boxDoc2, name, {});
    expectNoOp(r, boxDoc2);
    expectPure(boxDoc2, () => [execute(boxDoc2, name, {}), execute(boxDoc2, name, { binary: true })]);
    expect(toToolSchemas().find((s) => s.name === name)?.annotations?.readOnlyHint).toBe(true);
  });

  it.each([
    ['export_obj', 'obj'],
    ['export_gltf', 'gltf'],
  ])('%s: empty doc, unknown ids and 2D-only docs export 0 triangles', (name, format) => {
    const doc = empty();
    const r = execute(doc, name, {});
    expectNoOp(r, doc);
    expect(r.data).toMatchObject({ triangleCount: 0, format });
    const ghost = execute(doc, name, { entityIds: ['ghost-id'] });
    expect((ghost.data as ObjData).triangleCount).toBe(0);
    expect(ghost.affected).toEqual([]);
    expect(ghost.summary).toContain('ghost-id');
    expect((execute(chain(['draw_polyline', { points: xy(0, 0, 5, 5) }]), name, {}).data as ObjData).triangleCount).toBe(0);
  });

  it('OBJ: box has 36 v, 12 f records; spheres, subsets and revolutions export', () => {
    const data = execute(boxDoc2, 'export_obj', {}).data as ObjData;
    expect([data.format, data.triangleCount]).toEqual(['obj', 12]);
    for (const t of ['v ', 'vn ', 'f ']) expect(data.text).toContain(t);
    const lines = data.text.split('\n');
    expect(lines.filter((l) => /^v /.test(l))).toHaveLength(36);
    expect(lines.filter((l) => /^f /.test(l))).toHaveLength(12);
    const sphere = execute(run(empty(), 'add_sphere', { radius: 1 }), 'export_obj', {}).data as ObjData;
    expect(sphere.triangleCount).toBeGreaterThan(0);
    expect(sphere.text.length).toBeGreaterThan(0);
    const both = run(boxDoc2, 'add_sphere', { radius: 1 });
    expect((execute(both, 'export_obj', { entityIds: [both.order[0]] }).data as ObjData).triangleCount).toBe(12);
    for (const segments of [8, 12]) {
      const rev = execute(revolved(segments), 'export_obj', {}).data as ObjData;
      expect(rev.triangleCount).toBeGreaterThan(0);
      expect(rev.text).toContain('v ');
      expect(rev.text).toContain('f ');
    }
  });

  it('glTF JSON: valid 2.0 structure with an inlined data: buffer', () => {
    const doc = run(boxDoc2, 'add_sphere', { radius: 1 });
    const data = execute(doc, 'export_gltf', {}).data as GltfData;
    expect(data.format).toBe('gltf');
    expect(data.triangleCount).toBeGreaterThan(12);
    const gltf = JSON.parse(data.text!) as Record<string, unknown>;
    expect(gltf).toMatchObject({ asset: { version: '2.0' }, scene: 0 });
    for (const k of ['scenes', 'meshes', 'accessors', 'bufferViews', 'buffers']) expect(Array.isArray(gltf[k])).toBe(true);
    expect((gltf['buffers'] as Array<{ uri: string }>)[0]!.uri.startsWith('data:application/octet-stream;base64,')).toBe(true);
    expect(execute(unitBox, 'export_gltf', { binary: false }).data).toMatchObject({
      triangleCount: 12,
      format: 'gltf',
      text: expect.any(String),
    });
    expect(() => JSON.parse((execute(empty(), 'export_gltf', {}).data as GltfData).text!)).not.toThrow();
    for (const segments of [8, 12]) {
      const rev = execute(revolved(segments), 'export_gltf', {}).data as GltfData;
      expect(rev.triangleCount).toBeGreaterThan(0);
      expect((JSON.parse(rev.text!) as { asset: { version: string } }).asset.version).toBe('2.0');
    }
  });

  it('GLB: magic, version, length and JSON chunk header; empty docs still get a header', () => {
    const { data, view } = glb(unitBox);
    expect([data.format, data.triangleCount, data.base64 !== undefined]).toEqual(['glb', 12, true]);
    expect([view.getUint32(0, true), view.getUint32(4, true), view.getUint32(16, true)]).toEqual([0x46546c67, 2, 0x4e4f534a]);
    const big = glb(boxDoc2).view;
    expect(big.getUint32(8, true)).toBe(big.byteLength);
    const e = glb(empty());
    expect(e.data.triangleCount).toBe(0);
    expect(e.view.getUint32(0, true)).toBe(0x46546c67);
    expect(glb(revolved(8)).data.triangleCount).toBeGreaterThan(0);
  });

  it('revolutions export to STL', () => {
    const data = stl(revolved(12));
    expect(data.triangleCount).toBeGreaterThan(0);
    expect(data.stl).toContain('facet normal');
  });
});

/** Boxes at the given [size, position] pairs. */
function placed(...specs: number[][][]): { doc: CadDocument; ids: string[] } {
  let doc = empty();
  const ids: string[] = [];
  for (const [size, position] of specs) ({ doc, id: ids[ids.length] } = add(doc, 'add_box', { size, position }));
  return { doc, ids };
}
const pos = (doc: CadDocument, id: string): readonly number[] => doc.entities[id]!.position;
const gap = (doc: CadDocument, a: string, b: string): number =>
  Math.hypot(pos(doc, a)[0]! - pos(doc, b)[0]!, pos(doc, a)[1]! - pos(doc, b)[1]!);

describe('align / distribute / stack_on', () => {
  it.each<[string, number[][][], (ids: string[]) => object, number, number, number[]?]>([
    [
      'align min-x',
      [xyz(2, 2, 2, 10, 0, 0), xyz(2, 2, 2, 0, 0, 0)],
      ([r, t]) => ({ targetIds: [t], edge: 'min-x', referenceId: r }),
      1,
      0,
      [10],
    ],
    [
      'align center-z',
      [xyz(2, 2, 4, 0, 0, 10), xyz(2, 2, 2, 5, 0, 0)],
      ([r, t]) => ({ targetIds: [t], edge: 'center-z', referenceId: r }),
      1,
      2,
      [10],
    ],
    [
      'distribute equal-spacing x',
      [xyz(2, 2, 2, 0, 0, 0), xyz(2, 2, 2, 5, 0, 0), xyz(2, 2, 2, 20, 0, 0)],
      (ids) => ({ targetIds: ids, axis: 'x', mode: 'equal-spacing' }),
      1,
      0,
      [10],
    ],
    [
      'distribute equal-gap z',
      [xyz(2, 2, 2, 0, 0, 0), xyz(2, 2, 2, 0, 0, 3), xyz(2, 2, 2, 0, 0, 20)],
      (ids) => ({ targetIds: ids, axis: 'z', mode: 'equal-gap' }),
      1,
      2,
      [10],
    ],
    ['stack_on z', [xyz(4, 4, 2, 0, 0, 0), xyz(2, 2, 2, 0, 0, 0)], ([b, m]) => ({ movingId: m, baseId: b }), 1, 2, [2]],
    ['stack_on x', [xyz(4, 2, 2, 0, 0, 0), xyz(2, 2, 2, 0, 0, 0)], ([b, m]) => ({ movingId: m, baseId: b, axis: 'x' }), 1, 0, [3]],
  ])('%s moves the target, purely', (label, specs, p, moved, axis, [value] = []) => {
    const { doc, ids } = placed(...specs);
    const name = label.split(' ')[0]!;
    const r = execute(doc, name, p(ids));
    expect(r.affected).toContain(ids[moved]);
    if (name === 'stack_on') expect(r.affected).toEqual([ids[moved]]);
    if (name === 'distribute' && label.endsWith('x')) for (const i of [0, 2]) expect(r.affected).not.toContain(ids[i]);
    expect(pos(r.document, ids[moved]!)[axis]).toBeCloseTo(value!);
    expectPure(doc, () => execute(doc, name, p(ids)));
  });

  it.each<[string, (id: string) => object, string?]>([
    ['align', () => ({ targetIds: ['some-id'], edge: 'min-x', referenceId: 'no-such' }), 'no-such'],
    ['align', (id) => ({ targetIds: ['ghost'], edge: 'max-x', referenceId: id })],
    ['distribute', (id) => ({ targetIds: [id], axis: 'x' }), 'at least 2'],
    ['distribute', (id) => ({ targetIds: [id, 'ghost'], axis: 'y' })],
    ['stack_on', (id) => ({ movingId: 'ghost', baseId: id })],
    ['stack_on', (id) => ({ movingId: id, baseId: 'ghost' })],
  ])('%s is a no-op (%#)', (name, p, summary) => expectNoOp(execute(boxDoc, name, p(boxId)), boxDoc, summary));
});

describe('build_project repeat/for_each', () => {
  const plan = (doc: CadDocument, actions: unknown[], extra: object = {}): ReturnType<typeof execute> =>
    execute(doc, 'build_project', { actions, ...extra });
  const boxStep = { command: 'add_box', params: { size: [1, 1, 1] } };
  const xs = (r: ReturnType<typeof execute>): number[] => r.affected.map((id) => r.document.entities[id]!.position[0]);
  const radii = (r: ReturnType<typeof execute>): unknown[] => r.affected.map((id) => (r.document.entities[id] as Loose)['radius']);

  it('repeat: literal and parameter counts, $i in params, purely', () => {
    const r = plan(empty(), [{ repeat: { count: 5 }, step: boxStep }]);
    expect([r.document.order.length, r.affected.length]).toEqual([5, 5]);
    const positioned = plan(empty(), [
      { repeat: { count: 3 }, step: { command: 'add_box', params: { size: [1, 1, 1], position: ['=i * 3', 0, 0] } } },
    ]);
    expect(xs(positioned)).toEqual([0, 3, 6]);
    expect(plan(params(['N', '4']), [{ repeat: { count: '=N + 1' }, step: boxStep }]).affected).toHaveLength(5);
    const doc = empty();
    expectPure(doc, () => plan(doc, [{ repeat: { count: 3 }, step: boxStep }]));
  });

  it('for_each: values array, $i, scalar expression values', () => {
    const sphereR = { command: 'add_sphere', params: { radius: '=$r' } };
    expect(radii(plan(empty(), [{ for_each: { values: [1, 2, 4], as: 'r' }, step: sphereR }]))).toEqual([1, 2, 4]);
    const indexed = plan(empty(), [
      {
        for_each: { values: [10, 20, 30], as: 'val' },
        step: { command: 'add_box', params: { size: [1, 1, 1], position: ['=i * 5', 0, 0] } },
      },
    ]);
    expect(xs(indexed)).toEqual([0, 5, 10]);
    expect(radii(plan(params(['radius', '7']), [{ for_each: { values: '=radius', as: 'r' }, step: sphereR }]))).toEqual([7]);
  });

  it.each<[unknown[], string]>([
    [[{ repeat: { count: -1 }, step: boxStep }], 'continue'],
    [[{ for_each: { values: '=unknown_param_xyz', as: 'r' }, step: { command: 'add_sphere', params: { radius: 1 } } }], 'continue'],
    [[boxStep, { repeat: { count: -2 }, step: boxStep }], 'abort'],
  ])('a failing control-flow step creates nothing (%#)', (actions, onError) => {
    const doc = empty();
    const r = plan(doc, actions, { onError });
    expect([r.document.order.length, r.affected.length]).toEqual([0, 0]);
    if (onError === 'abort') expect(r.document).toBe(doc);
  });
});

describe('constraints', () => {
  const pair = placed(
    [
      [1, 1, 1],
      [0, 0, 0],
    ],
    [
      [1, 1, 1],
      [5, 0, 0],
    ],
  );
  const [a, b] = pair.ids as [string, string];
  const constrain = (doc: CadDocument, kind: string, x: string, y: string, extra: object = {}): ReturnType<typeof execute> =>
    execute(doc, 'add_constraint', { constraint: { kind, a: { entityId: x }, b: { entityId: y }, ...extra } });
  const solve = (doc: CadDocument): { doc: CadDocument; data: { residual: number; iterations: number; converged: boolean } } => {
    const r = execute(doc, 'solve_constraints', {});
    return { doc: r.document, data: r.data as { residual: number; iterations: number; converged: boolean } };
  };
  const coincident = constrain(pair.doc, 'coincident', a, b);
  const distance = constrain(pair.doc, 'distance', a, b, { value: 5 });

  it('add_constraint stores coincident / distance constraints (explicit ids too), purely', () => {
    const cid = coincident.affected[0]!;
    expect(coincident.affected).toHaveLength(1);
    expect(coincident.document.constraints[cid]!.kind).toBe('coincident');
    expect(coincident.document.constraintOrder).toContain(cid);
    expect(coincident.summary).toContain(cid);
    const d10 = constrain(pair.doc, 'distance', a, b, { value: 10 });
    expect(d10.document.constraints[d10.affected[0]!]).toMatchObject({ kind: 'distance', value: 10 });
    const named = execute(pair.doc, 'add_constraint', {
      constraint: { kind: 'coincident', a: { entityId: a }, b: { entityId: b } },
      id: 'dup',
    });
    expect(named.affected).toEqual(['dup']);
    expect(named.document.constraints['dup']).toBeDefined();
    expectNoOp(
      execute(named.document, 'add_constraint', { constraint: { kind: 'coincident', a: { entityId: a }, b: { entityId: b } }, id: 'dup' }),
      named.document,
    );
    expectPure(pair.doc, () => constrain(pair.doc, 'coincident', a, b));
  });

  it.each<[string, object, string?]>([
    ['add_constraint', { constraint: { kind: 'invalid_kind', a: { entityId: 'e1' }, b: { entityId: 'e2' } } }, 'invalid_kind'],
    ['add_constraint', { constraint: { kind: 'distance', a: { entityId: 'e1' }, b: { entityId: 'e2' } } }],
    ['delete_constraint', { id: 'ghost-con' }, 'ghost-con'],
    ['update_constraint', { id: 'no-such', patch: { value: 5 } }, 'no-such'],
  ])('%s %j is a no-op', (name, p, summary) => {
    const doc = empty();
    expectNoOp(execute(doc, name, p), doc, summary);
  });

  it('delete_constraint removes it from constraints and order, purely', () => {
    const cid = coincident.affected[0]!;
    const r = execute(coincident.document, 'delete_constraint', { id: cid });
    expect(r.document.constraints[cid]).toBeUndefined();
    expect(r.document.constraintOrder).not.toContain(cid);
    expect(r.affected).toHaveLength(0);
    expect(r.summary).toContain(cid);
    expectPure(coincident.document, () => execute(coincident.document, 'delete_constraint', { id: cid }));
  });

  it('update_constraint patches distance values (numbers or parameter names), refuses geometric ones, purely', () => {
    const cid = distance.affected[0]!;
    const r = execute(distance.document, 'update_constraint', { id: cid, patch: { value: 12 } });
    expect(r.affected).toContain(cid);
    expect(r.document.constraints[cid]).toMatchObject({ value: 12 });
    expect(r.summary).toContain(cid);
    expect(run(distance.document, 'update_constraint', { id: cid, patch: { value: 'gap' } }).constraints[cid]).toMatchObject({
      value: 'gap',
    });
    expectNoOp(
      execute(coincident.document, 'update_constraint', { id: coincident.affected[0], patch: { value: 99 } }),
      coincident.document,
    );
    expectPure(distance.document, () => execute(distance.document, 'update_constraint', { id: cid, patch: { value: 20 } }));
  });

  it('solve_constraints: trivially converged when empty; coincident converges; always reports residual/iterations, purely', () => {
    const e = solve(empty());
    expect(e.doc.entities).toEqual({});
    expect(e.data).toMatchObject({ converged: true, iterations: 0 });
    const c = solve(coincident.document);
    expect(gap(c.doc, a, b)).toBeLessThan(0.01);
    expect(c.data.converged).toBe(true);
    expect(c.data.residual).toBeLessThan(1e-6);
    expect(c.data.iterations).toBeGreaterThan(0);
    expect(typeof c.data.residual).toBe('number');
    const same = placed(
      [
        [1, 1, 1],
        [0, 0, 0],
      ],
      [
        [1, 1, 1],
        [0, 0, 0],
      ],
    );
    expect(typeof solve(constrain(same.doc, 'distance', same.ids[0]!, same.ids[1]!, { value: 10 }).document).data.residual).toBe('number');
    expectPure(coincident.document, () => execute(coincident.document, 'solve_constraints', {}));
  });

  it('solve_constraints follows parameter changes', () => {
    const start = placed(
      [
        [1, 1, 1],
        [0, 0, 0],
      ],
      [
        [1, 1, 1],
        [2, 0, 0],
      ],
    );
    const [x, y] = start.ids as [string, string];
    const withGap = (doc: CadDocument, value: number): CadDocument => ({
      ...doc,
      parameters: { gap: { name: 'gap', expression: String(value), value } },
    });
    const s1 = solve(constrain(withGap(start.doc, 8), 'distance', x, y, { value: 'gap' }).document).doc;
    const d1 = gap(s1, x, y);
    expect(d1).toBeGreaterThan(2);
    expect(gap(solve(withGap(s1, 4)).doc, x, y)).toBeLessThan(d1 + 0.1);
  });

  it.each<[string, object, number, number]>([
    ['coincident', {}, 0, 0.01],
    ['distance', { value: 5 }, 3, 7],
  ])('%s mates between assembly instances solve', (kind, extra, min, max) => {
    let doc = empty();
    const insts: string[] = [];
    for (const [name, dx] of [
      ['A', 2],
      ['B', 8],
    ] as const) {
      const s = box(doc);
      const c = execute(s.doc, 'create_component', { name, entityIds: [s.id] });
      insts.push(c.affected[0]!);
      doc = run(c.document, 'move_entities', { ids: [c.affected[0]], delta: [kind === 'distance' ? (name === 'B' ? 20 : 0) : dx, 0, 0] });
    }
    const [ia, ib] = insts as [string, string];
    const mate = constrain(doc, kind, ia, ib, extra);
    expect(mate.affected).toHaveLength(1);
    expect(mate.document.constraints[mate.affected[0]!]).toMatchObject({ kind, ...extra });
    expect(mate.document.constraintOrder).toContain(mate.affected[0]);
    const d = gap(solve(mate.document).doc, ia, ib);
    expect(d).toBeGreaterThanOrEqual(min);
    expect(d).toBeLessThan(max);
  });
});

describe('bill_of_materials', () => {
  type Bom = {
    rows: Array<{
      componentId: string;
      componentName: string;
      count: number;
      orphan?: boolean;
      perEntityKindCounts: Record<string, number>;
    }>;
    totalInstances: number;
    distinctComponents: number;
  };
  const bom = (doc: CadDocument): { r: ReturnType<typeof execute>; data: Bom } => {
    const r = execute(doc, 'bill_of_materials', {});
    return { r, data: r.data as Bom };
  };
  const component = (doc: CadDocument, name: string, kind: string, p: object, extra = 0): CadDocument => {
    const s = add(doc, kind, p);
    let d = run(s.doc, 'create_component', { name, entityIds: [s.id] });
    const componentId = Object.values(d.components).find((c) => c.name === name)!.id;
    for (let i = 0; i < extra; i++) d = run(d, 'insert_instance', { componentId });
    return d;
  };

  it('no instances → empty rows, read-only', () => {
    const { r, data } = bom(boxDoc);
    expectNoOp(r, boxDoc);
    expect(data).toMatchObject({ rows: [], totalInstances: 0, distinctComponents: 0 });
  });

  it('groups instances per component with per-kind counts; summary names them; pure', () => {
    const one = component(empty(), 'Bracket', 'add_box', { size: [1, 1, 1] });
    expect(bom(one).r.summary).toContain('1');
    expect(bom(one).r.summary).toContain('Bracket');
    expectPure(one, () => execute(one, 'bill_of_materials', {}));
    const bolt = bom(component(empty(), 'Bolt', 'add_box', { size: [1, 1, 1] }, 1)).data;
    expect(bolt).toMatchObject({
      totalInstances: 2,
      distinctComponents: 1,
      rows: [{ componentName: 'Bolt', count: 2, perEntityKindCounts: { box: 1 } }],
    });
    const mixed = bom(
      component(component(empty(), 'Wheel', 'add_cylinder', { radius: 1, height: 0.5 }, 1), 'Hub', 'add_sphere', { radius: 0.5 }, 1),
    ).data;
    expect([mixed.totalInstances, mixed.distinctComponents]).toEqual([4, 2]);
    expect(mixed.rows.find((r) => r.componentName === 'Wheel')).toMatchObject({ count: 2, perEntityKindCounts: { cylinder: 1 } });
    expect(mixed.rows.find((r) => r.componentName === 'Hub')).toMatchObject({ count: 2, perEntityKindCounts: { sphere: 1 } });
  });

  it('an orphan instance yields a warning row', () => {
    const orphan = {
      id: 'orphan-inst-1',
      kind: 'instance',
      componentId: 'ghost-comp-id',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#c8553d',
    };
    const doc = { ...empty(), entities: { 'orphan-inst-1': orphan as unknown as Entity }, order: ['orphan-inst-1'] };
    const { r, data } = bom(doc);
    expect(r.affected).toHaveLength(0);
    expect(data).toMatchObject({
      totalInstances: 1,
      distinctComponents: 0,
      rows: [{ orphan: true, componentName: '(missing)', componentId: 'ghost-comp-id' }],
    });
  });
});

describe('replayHistory preserves non-regenerated document state', () => {
  const steel = { ...STEEL, roughness: 0.1 };

  it('configurations, materials and components survive edit_step_params without duplication', () => {
    const s = box(run(run(empty(), 'create_configuration', { name: 'small', parameterValues: { w: '10' } }), 'create_material', steel));
    const doc = run(run(s.doc, 'create_component', { name: 'Unit', entityIds: [s.id] }), 'add_box', { size: [2, 2, 2] });
    const edited = run(doc, 'edit_step_params', { stepId: doc.featureHistory.at(-1)!.id, params: { size: [3, 3, 3] } });
    expect(edited.configurations['small']).toBeDefined();
    expect(edited.materials['steel']).toBeDefined();
    expect(Object.keys(edited.components)).toHaveLength(1);
    expect(Object.keys(doc.components)).toHaveLength(1);
  });

  it('orphan materials, components and constraints survive suppress; step-produced materials do not', () => {
    const doc: CadDocument = {
      ...boxDoc,
      materials: { loaded: { ...steel, name: 'loaded' } },
      components: { 'comp-x': { id: 'comp-x', name: 'X', entities: {}, order: [] } },
      constraints: { 'con-x': { id: 'con-x' } as never },
      constraintOrder: ['con-x'],
    };
    const r = run(doc, 'set_step_suppressed', { stepId: doc.featureHistory[0]!.id, suppressed: true });
    expect(r.entities).toEqual({});
    expect([!!r.materials['loaded'], !!r.components['comp-x'], !!r.constraints['con-x']]).toEqual([true, true, true]);
    expect(r.constraintOrder).toEqual(['con-x']);
    const m = run(empty(), 'create_material', steel);
    expect(run(m, 'set_step_suppressed', { stepId: m.featureHistory[0]!.id, suppressed: true }).materials['steel']).toBeUndefined();
  });
});

describe('allocation limits', () => {
  const boxStep = { command: 'add_box', params: { size: [1, 1, 1] } };
  let nested: unknown = boxStep;
  for (let i = 0; i < 6; i++) nested = { command: 'build_project', params: { actions: [nested] } };

  it.each<[string, object, string]>([
    ['build_project', { actions: Array.from({ length: 1001 }, () => boxStep) }, 'MAX_PROJECT_ACTIONS'],
    ['build_project', { actions: [{ repeat: { count: 1_000_000 }, step: boxStep }] }, 'MAX_PROJECT_STEPS'],
    ['build_project', { actions: [{ for_each: { values: new Array(10_001).fill(1), as: 'v' }, step: boxStep }] }, 'MAX_PROJECT_STEPS'],
    ['build_project', { actions: [nested] }, 'MAX_PROJECT_DEPTH'],
    ['draw_spline', { points: Array.from({ length: 10_001 }, (_, i) => [i, 0]) }, 'MAX_SPLINE_CONTROL_POINTS'],
  ])('%s over the limit is rejected (%s)', (name, p, summary) => {
    const doc = empty();
    expectNoOp(execute(doc, name, p), doc, summary);
  });

  it('plans within limits run; self-referential recipes stop', () => {
    expect(execute(empty(), 'build_project', { actions: [{ repeat: { count: 3 }, step: boxStep }] }).affected).toHaveLength(3);
    const loop = {
      name: 'loop',
      steps: [{ id: 's1', name: 'instantiate_recipe', params: { name: 'loop' }, suppressed: false, affected: [] }],
    };
    const r = execute({ ...empty(), recipes: { loop: loop as never } }, 'instantiate_recipe', { name: 'loop' });
    expect(r.summary).toBeDefined();
    expect(r.affected).toEqual([]);
  });
});

describe('guardCommand contract', () => {
  it('free text equal to an Object.prototype key is accepted', () => {
    const text = execute(empty(), 'add_text', { content: 'constructor', position: [0, 0, 0], height: 1 });
    expect(text.affected).toHaveLength(1);
    expect(execute(text.document, 'set_entity_name', { id: text.affected[0], name: 'valueOf' }).affected).toHaveLength(1);
    expect(execute(empty(), 'add_layer', { name: 'hasOwnProperty' }).document).not.toEqual(empty());
    const plan = execute(empty(), 'build_project', {
      actions: [{ command: 'add_text', params: { content: 'toString', position: [0, 0, 0], height: 1 } }],
    });
    expect(plan.affected).toHaveLength(1);
    expect(execute(empty(), 'describe_scene', {}).data).toBeDefined();
  });

  it('prototype-key ids and malformed positions are no-ops; [x, y] pads z=0', () => {
    for (const id of ['constructor', '__proto__', 'toString']) expectNoOp(execute(boxDoc, 'delete_entities', { ids: [id] }), boxDoc);
    const doc = empty();
    for (const position of ['abc', [1], 5]) expectNoOp(execute(doc, 'add_box', { size: [1, 1, 1], position }), doc);
    expect(execute(doc, 'add_box', { size: [1, 1, 1], position: [1] }).summary).toContain('malformed position');
    expect(first(execute(doc, 'add_box', { size: [1, 1, 1], position: [2, 3] })).position).toEqual([2, 3, 0]);
    const schema = toToolSchemas().find((t) => t.name === 'add_box')!;
    expect(schema.input_schema.properties['position']!.description).toContain('[x, y] is accepted and placed at z=0');
  });

  it('a throwing command yields the no-op path and warns with the command name', () => {
    const doc = empty();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const p = {};
    Object.defineProperty(p, 'size', {
      enumerable: false,
      get(): never {
        throw new Error('boom');
      },
    });
    const r = execute(doc, 'add_box', p);
    expectNoOp(r, doc);
    expect(r.summary).toBe('add_box rejected: invalid params — boom');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('add_box'), expect.anything());
    warn.mockRestore();
  });
});

describe('delete_entities (batch)', () => {
  const { doc, ids } = boxes(3);

  it('deletes several in one history step, skipping missing ids, pruning selection and dissolving groups, purely', () => {
    const r = execute(doc, 'delete_entities', { ids: [ids[0], ids[1], 'ghost', ids[0]] });
    expect(r.affected).toEqual([ids[0], ids[1]]);
    expect(r.document.order).toEqual([ids[2]]);
    expect(Object.keys(r.document.entities)).toEqual([ids[2]]);
    expect(r.document.featureHistory).toHaveLength(doc.featureHistory.length + 1);
    expect(r.summary).toContain('Skipped missing: [ghost]');
    const grouped = { ...run(doc, 'group_entities', { ids: [ids[0], ids[1]] }), selection: [ids[0]!, ids[2]!] };
    const g = execute(grouped, 'delete_entities', { ids: [ids[0]] });
    expect(g.document.selection).toEqual([ids[2]]);
    expect(g.document.groups).toEqual({});
    expect(g.summary).toContain('Dissolved');
    expectPure(doc, () => execute(doc, 'delete_entities', { ids }));
  });

  it.each<[unknown]>([[[]], ['a'], [[1]], [['ghost']], [new Array(10_001).fill('x')]])('ids %# is a no-op', (bad) =>
    expectNoOp(execute(doc, 'delete_entities', { ids: bad }), doc),
  );
});
