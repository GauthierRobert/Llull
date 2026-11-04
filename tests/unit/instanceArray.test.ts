/** VIS-M8j (plant 09 VIS1): instance arrays: command, packed table, planScene parity with explicit instances, persistence, replay, load refusals. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { validateDocumentValues } from '@core/commands/persistence/validation';
import { decodedTransforms, memberAsInstance } from '@core/geometry/instanceArrays';
import { planScene } from '@core/geometry/renderPlan';
import { planSceneOf } from '@core/geometry/planSceneCache';
import { base64ToFloat64, float64ToBase64 } from '@lib/float64Base64';
import { instanceMemberId, parseInstanceMemberId, MAX_ARRAY_INSTANCES, type InstanceArray } from '@core/model/instanceArray';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { ARRAY_UNAWARE_COMMANDS, withOmittedArraysNotice } from '@core/commands/instanceArray/omittedNotice';
import { getCommand } from '@core/commands/registry';
import { apply, ok } from '../helpers/commandAssertions';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

/** A document with component `bolt` (a box and a cylinder). */
function withBolt(): CadDocument {
  let doc = createEmptyDocument();
  doc = apply(doc, 'add_box', { size: [10, 20, 30], position: [0, 0, 0] });
  doc = apply(doc, 'add_cylinder', { radius: 4, height: 50, position: [20, 0, 0] });
  return apply(doc, 'create_component', { name: 'Bolt', entityIds: doc.order, componentId: 'bolt' });
}

const GRID = { componentId: 'bolt', counts: [3, 2, 2], step: [100, 200, 300], origin: [5, 6, 7] };

function arrayOf(doc: CadDocument): InstanceArray {
  const arrays = Object.values(doc.instanceArrays ?? {});
  expect(arrays).toHaveLength(1);
  return arrays[0] as InstanceArray;
}

describe('add_instance_array', () => {
  it('stores one packed record, no Entity, and reports count and bounds', () => {
    const base = withBolt();
    const result = ok(base, 'add_instance_array', GRID);
    expect(result.affected).toEqual([]);
    expect(Object.keys(result.document.entities)).toEqual(Object.keys(base.entities));
    const array = arrayOf(result.document);
    expect(array).toMatchObject({ componentId: 'bolt', count: 12, encoding: 'f64le-base64', layerId: 'layer-default' });
    expect((result.data as { count: number }).count).toBe(12);
    const table = decodedTransforms(array) as Float64Array;
    expect(Array.from(table.slice(0, 6))).toEqual([5, 6, 7, 0, 0, 0]);
    expect(Array.from(table.slice(6, 12))).toEqual([105, 6, 7, 0, 0, 0]);
    expect(Array.from(table.slice(18, 24))).toEqual([5, 206, 7, 0, 0, 0]);
    expect(Array.from(table.slice(66, 72))).toEqual([205, 206, 307, 0, 0, 0]);
    expect(result.summary).toContain('12 x');
  });

  it.each([[{ ...GRID, rotation: [0.3, 0.5, 0.7], scale: [1, 2, 1.5] }], [{ ...GRID, step: [-100, 50, -300], origin: [-5, 0, 9] }]])(
    'data.bounds is the union of the members boxes',
    (params) => {
      const result = ok(withBolt(), 'add_instance_array', params);
      const members = planScene(result.document).instances.slice(1);
      const { min, max } = (result.data as { bounds: { min: number[]; max: number[] } }).bounds;
      for (const axis of [0, 1, 2]) {
        expect(min[axis]).toBeCloseTo(Math.min(...members.map((m) => m.aabb.min[axis]!)), 6);
        expect(max[axis]).toBeCloseTo(Math.max(...members.map((m) => m.aabb.max[axis]!)), 6);
      }
    },
  );

  it('is pure', () => {
    const doc = withBolt();
    expectPure(doc, () => execute(doc, 'add_instance_array', GRID));
  });

  it.each([
    ['unknown component', { ...GRID, componentId: 'nope' }, "component 'nope' does not exist"],
    ['unknown layer', { ...GRID, layerId: 'ghost' }, "layer 'ghost' does not exist"],
    ['bad colour', { ...GRID, color: 'red' }, 'not #rrggbb'],
    ['too many members', { ...GRID, counts: [2001, 2001, 1] }, 'exceed the limit'],
  ])('refuses %s with the document unchanged', (_label, params, text) => {
    const doc = withBolt();
    const result = execute(doc, 'add_instance_array', params);
    expectNoOp(result, doc, text);
    expect(result.summary).toContain('add_instance_array rejected');
  });

  it('refuses an empty component', () => {
    const doc = { ...withBolt(), components: { empty: { id: 'empty', name: 'E', entities: {}, order: [] } } } as CadDocument;
    expectNoOp(execute(doc, 'add_instance_array', { ...GRID, componentId: 'empty' }), doc, 'has no entities');
  });

  it('rejects non-integer counts and non-finite numbers in the schema', () => {
    const doc = withBolt();
    for (const bad of [
      { counts: [1.5, 1, 1] },
      { counts: [0, 1, 1] },
      { step: [Number.POSITIVE_INFINITY, 0, 0] },
      { origin: [Number.NaN, 0, 0] },
    ])
      expect(execute(doc, 'add_instance_array', { ...GRID, ...bad }).summary).toContain('invalid params');
  });
});

describe('planScene reads arrays without Entity objects', () => {
  it('a member equals the explicit instance entity: AABB, prototype key, diagonal, with rotation and scale', () => {
    const base = withBolt();
    const params = { ...GRID, counts: [2, 2, 1], rotation: [0.3, 0.5, 0.7], scale: [1, 2, 1.5] };
    const arrayDoc = apply(base, 'add_instance_array', params);
    const array = arrayOf(arrayDoc);
    // the same four placements as explicit entities
    let explicit = base;
    for (let i = 0; i < array.count; i++) {
      const member = memberAsInstance(array, i) as NonNullable<ReturnType<typeof memberAsInstance>>;
      const id = `x${i}`;
      explicit = { ...explicit, entities: { ...explicit.entities, [id]: { ...member, id } }, order: [...explicit.order, id] };
    }
    const fromArray = planScene(arrayDoc);
    const fromEntities = planScene(explicit);
    expect(fromArray.instances.map(({ id: _id, ...rest }) => rest)).toEqual(fromEntities.instances.map(({ id: _id, ...rest }) => rest));
    expect(fromArray.prototypeKeys).toEqual(fromEntities.prototypeKeys);
    expect(fromArray.prototypeTriangles).toEqual(fromEntities.prototypeTriangles);
    expect(fromArray.prototypeCounts).toEqual([1, 4]);
    expect(fromArray.instances.slice(1).map((i) => i.id)).toEqual([0, 1, 2, 3].map((i) => instanceMemberId(array.id, i)));
  });

  it('keeps entities first, then members; a hidden layer counts the whole array as hidden', () => {
    const doc = apply(withBolt(), 'add_instance_array', GRID);
    expect(planScene(doc).instances).toHaveLength(12 + 1);
    const hidden = {
      ...doc,
      layers: { ...doc.layers, 'layer-default': { ...doc.layers['layer-default']!, visible: false } },
    } as CadDocument;
    const scene = planScene(hidden);
    expect(scene.instances).toHaveLength(0);
    expect(scene.hiddenCount).toBe(13);
  });

  it('render_stats counts the members as components', () => {
    const doc = apply(withBolt(), 'add_instance_array', { ...GRID, counts: [10, 10, 10] });
    const stats = ok(doc, 'render_stats', { width: 800, height: 600 });
    expect((stats.data as { componentCount: number }).componentCount).toBe(1001);
    expect(planSceneOf(doc).scene.instances).toHaveLength(1001);
  });

  it('member ids round trip and refuse entity ids', () => {
    expect(parseInstanceMemberId(instanceMemberId('arr-3.1', 41))).toEqual({ arrayId: 'arr-3.1', index: 41 });
    for (const id of ['e1', '#5', 'a#', 'a#01', 'a#-1', 'a#1.5', 'a#9999999999']) expect(parseInstanceMemberId(id)).toBeNull();
  });
});

describe('persistence and replay', () => {
  it('saves and loads equal, with the table as one string and no per-member objects', () => {
    const doc = apply(withBolt(), 'add_instance_array', { ...GRID, counts: [20, 20, 5], rotation: [0.1, 0, 0.2] });
    const json = serializeDocument(doc);
    expect(json.length).toBeLessThan(200_000);
    const back = deserializeDocument(json);
    expect(back.instanceArrays).toEqual(doc.instanceArrays);
    expect(serializeDocument(back)).toBe(json);
    expect(planScene(back).instances.map((i) => i.aabb)).toEqual(planScene(doc).instances.map((i) => i.aabb));
  });

  it('load_document of a file with an array reports the document and keeps the slice', () => {
    const doc = apply(withBolt(), 'add_instance_array', GRID);
    const loaded = ok(createEmptyDocument(), 'load_document', { json: serializeDocument(doc) });
    expect(arrayOf(loaded.document).count).toBe(12);
  });

  it('replay regenerates the identical array (same id, same bytes)', () => {
    const doc = apply(withBolt(), 'add_instance_array', GRID);
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(replayed.instanceArrays).toEqual(doc.instanceArrays);
    expect(Object.keys(replayed.instanceArrays ?? {})).toEqual([`arr-${doc.featureHistory.at(-1)!.id.replace('step-', '')}.1`]);
  });

  it('later commands share the slice by reference (undo and replay cache cost nothing)', () => {
    const after = apply(withBolt(), 'add_instance_array', GRID);
    expect(apply(after, 'add_box', { size: [1, 1, 1] }).instanceArrays).toBe(after.instanceArrays);
  });

  it('clear_document removes the slice', () => {
    expect(execute(apply(withBolt(), 'add_instance_array', GRID), 'clear_document', {}).document.instanceArrays).toBeUndefined();
  });
});

describe('load validation of untrusted arrays', () => {
  const valid = (): { raw: Record<string, unknown>; array: InstanceArray } => {
    const doc = apply(withBolt(), 'add_instance_array', GRID);
    return { raw: JSON.parse(serializeDocument(doc)).document as Record<string, unknown>, array: arrayOf(doc) };
  };
  const problems = (mutate: (raw: Record<string, unknown>, id: string) => void): string[] => {
    const { raw, array } = valid();
    // a fresh object per case: the decode memo is keyed on the record, never shared with the valid sample
    mutate(raw, array.id);
    return validateDocumentValues(raw);
  };
  const slot = (raw: Record<string, unknown>, id: string): Record<string, unknown> =>
    (raw['instanceArrays'] as Record<string, Record<string, unknown>>)[id]!;

  it('accepts the valid sample', () => {
    const { raw } = valid();
    expect(validateDocumentValues(raw)).toEqual([]);
  });

  it.each([
    [
      'count disagrees with the table',
      (raw: Record<string, unknown>, id: string) => (slot(raw, id)['count'] = 13),
      'transforms must be base64',
    ],
    [
      'count beyond the limit',
      (raw: Record<string, unknown>, id: string) => (slot(raw, id)['count'] = MAX_ARRAY_INSTANCES + 1),
      'count must be an integer',
    ],
    ['count not an integer', (raw: Record<string, unknown>, id: string) => (slot(raw, id)['count'] = 1.5), 'count must be an integer'],
    [
      'table not base64',
      (raw: Record<string, unknown>, id: string) => (slot(raw, id)['transforms'] = '!'.repeat(384)),
      'transforms must be base64',
    ],
    [
      'table truncated',
      (raw: Record<string, unknown>, id: string) => (slot(raw, id)['transforms'] = String(slot(raw, id)['transforms']).slice(0, 100)),
      'transforms must be base64',
    ],
    [
      'table not a string',
      (raw: Record<string, unknown>, id: string) => (slot(raw, id)['transforms'] = [1, 2]),
      'transforms must be base64',
    ],
    [
      'NaN inside the table',
      (raw: Record<string, unknown>, id: string) => (slot(raw, id)['transforms'] = nanTable(12)),
      'transforms must be base64',
    ],
    ['unknown component', (raw: Record<string, unknown>, id: string) => (slot(raw, id)['componentId'] = 'ghost'), 'componentId must name'],
    ['unknown layer', (raw: Record<string, unknown>, id: string) => (slot(raw, id)['layerId'] = 'ghost'), 'layerId must name'],
    ['unknown encoding', (raw: Record<string, unknown>, id: string) => (slot(raw, id)['encoding'] = 'f32'), 'encoding must be'],
    ['bad colour', (raw: Record<string, unknown>, id: string) => (slot(raw, id)['color'] = 'red'), 'color must be'],
    ['bad scale', (raw: Record<string, unknown>, id: string) => (slot(raw, id)['scale'] = [1, 'x', 1]), 'scale must be'],
    ['id disagrees with the key', (raw: Record<string, unknown>, id: string) => (slot(raw, id)['id'] = 'other'), 'whose id is'],
    [
      'entry not an object',
      (raw: Record<string, unknown>, id: string) => ((raw['instanceArrays'] as Record<string, unknown>)[id] = 7),
      'whose id is',
    ],
    ['slice not an object', (raw: Record<string, unknown>) => (raw['instanceArrays'] = []), 'instanceArrays must be an object'],
    [
      'reserved key',
      (raw: Record<string, unknown>) => (raw['instanceArrays'] = JSON.parse('{"__proto__":{"id":"__proto__"}}')),
      'reserved',
    ],
  ])('refuses %s', (_label, mutate, text) => {
    expect(problems(mutate).join('\n')).toContain(text);
  });
});

function nanTable(count: number): string {
  const values = new Float64Array(count * 6);
  values[7] = Number.NaN;
  return float64ToBase64(values);
}

describe('float64 base64 codec', () => {
  it('round trips values including negative zero and subnormals, little endian', () => {
    const values = Float64Array.from([0, -0, 1, -1.5, 5e-324, 1e308, Math.PI]);
    const text = float64ToBase64(values);
    expect(base64ToFloat64(text, values.length)).toEqual(values);
    expect(Object.is(base64ToFloat64(text, 7)?.[1], -0)).toBe(true);
    expect(float64ToBase64(Float64Array.of(1))).toBe('AAAAAAAA8D8=');
  });
  it('refuses a wrong count and bad text', () => {
    expect(base64ToFloat64(float64ToBase64(Float64Array.of(1, 2)), 3)).toBeNull();
    expect(base64ToFloat64('AAAAAAAA8D8*', 1)).toBeNull();
  });
});

describe('surfaces that do not read instance arrays say so', () => {
  const withArray = (): CadDocument => apply(withBolt(), 'add_instance_array', GRID);
  const SURFACES: readonly (readonly [string, Record<string, unknown>])[] = [
    ['export_gltf', {}],
    ['export_obj', {}],
    ['export_stl', {}],
    ['export_3mf', {}],
    ['export_code', { language: 'cadquery' }],
    ['check_clashes', {}],
    ['bill_of_materials', {}],
    ['fit_view', {}],
    ['render_view', { view: 'top', mode: 'vector', width: 100, height: 100 }],
    ['explode_instance', { id: 'nothing' }],
  ];

  it.each(SURFACES)('%s names the 12 omitted members', (name, params) => {
    const result = execute(withArray(), name, params);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.summary).toContain('1 instance array (12 members) not included');
  });

  it.each(SURFACES)('%s adds nothing without arrays', (name, params) => {
    expect(execute(withBolt(), name, params).summary).not.toContain('instance array');
  });

  it('every listed command is annotated by the wrapper, a refusal and a document without arrays are not', () => {
    const doc = withArray();
    const done = { document: doc, summary: 'done.', affected: [] };
    for (const name of ARRAY_UNAWARE_COMMANDS)
      expect(withOmittedArraysNotice(doc, name, done).summary).toContain('(12 members) not included');
    expect(withOmittedArraysNotice(doc, 'export_gltf', { ...done, rejected: true }).summary).toBe('done.');
    expect(withOmittedArraysNotice(doc, 'render_stats', done).summary).toBe('done.');
    expect(withOmittedArraysNotice(withBolt(), 'export_gltf', done).summary).toBe('done.');
    expect([...ARRAY_UNAWARE_COMMANDS].every((name) => getCommand(name) !== undefined)).toBe(true);
  });

  it('render_stats, which reads arrays, is not annotated', () => {
    expect(execute(withArray(), 'render_stats', { width: 100, height: 100 }).summary).not.toContain('not included');
  });
});

describe('add_instance_array overflow and property', () => {
  it.each([
    ['position overflow', { ...GRID, counts: [4000, 1, 1], step: [1e308, 0, 0] }, 'not finite'],
    ['bounds overflow', { ...GRID, counts: [1, 1, 1], scale: [1e308, 1e308, 1e308] }, 'not finite'],
  ])('refuses %s with the document unchanged', (_label, params, text) => {
    const doc = withBolt();
    expectNoOp(execute(doc, 'add_instance_array', params), doc, text);
  });

  it('every document it accepts passes load validation (seeded sweep including extreme numbers)', () => {
    let seed = 12345;
    const next = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const pick = (): number => [0, 1, -3.5, 1e-9, 1e6, 1e154, 1e200, 1e308, -1e308][Math.floor(next() * 9)]!;
    const base = withBolt();
    let accepted = 0;
    for (let k = 0; k < 120; k++) {
      const params = {
        componentId: 'bolt',
        counts: [1 + Math.floor(next() * 40), 1 + Math.floor(next() * 40), 1 + Math.floor(next() * 3)],
        step: [pick(), pick(), pick()],
        origin: [pick(), pick(), pick()],
        rotation: [next() * 7, next() * 7, next() * 7],
        scale: [pick(), pick(), pick()],
      };
      const result = execute(base, 'add_instance_array', params);
      if (result.document === base) continue;
      accepted++;
      const raw = JSON.parse(serializeDocument(result.document)).document as Record<string, unknown>;
      expect(validateDocumentValues(raw), JSON.stringify(params)).toEqual([]);
    }
    expect(accepted).toBeGreaterThan(10);
  });
});

describe('entity ids and member ids', () => {
  const renamed = (doc: CadDocument, from: string, to: string): Record<string, unknown> => {
    const raw = JSON.parse(serializeDocument(doc)).document as Record<string, unknown>;
    const entities = raw['entities'] as Record<string, Record<string, unknown>>;
    entities[to] = { ...entities[from]!, id: to };
    delete entities[from];
    raw['order'] = (raw['order'] as string[]).map((id) => (id === from ? to : id));
    return raw;
  };

  it('a loaded document with an entity id naming a member of one of its arrays is refused', () => {
    const doc = ok(withBolt(), 'add_instance_array', GRID).document;
    const member = `${arrayOf(doc).id}#1`;
    expect(validateDocumentValues(renamed(doc, doc.order[0]!, member)).join('\n')).toContain(`is a member id of instance array`);
  });

  it('old documents with # in entity ids (v1 / v2 "#3:axis") still load when no array claims them', () => {
    const doc = apply(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    for (const id of ['#3:axis', '#1', 'e#1']) expect(validateDocumentValues(renamed(doc, doc.order[0]!, id))).toEqual([]);
  });
});
