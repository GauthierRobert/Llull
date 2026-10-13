import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence/serialization';
import { expectDocumentEnvelope } from '../helpers/documentEnvelope';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { build } from '../helpers/addEntity';
import { xy } from '../helpers/xy';
import { validateDocumentValues } from '@core/commands/persistence/validation';

/** A minimal valid llull-document v1 envelope; `doc` overrides document fields. */
function envelope(doc: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: 'llull-document',
    version: 1,
    document: {
      entities: {},
      order: [],
      layers: { 'layer-default': { id: 'layer-default', name: 'Default', visible: true, locked: false } },
      layerOrder: ['layer-default'],
      selection: [],
      camera: { target: [0, 0, 0], azimuth: 0, polar: Math.PI / 4, distance: 10 },
      ...doc,
    },
  });
}
/** Envelope holding one entity of `kind` with valid base fields plus `extras`. */
const withEntity = (kind: string, extras: Record<string, unknown> = {}): string =>
  envelope({
    entities: { e1: { id: 'e1', kind, position: [0, 0, 0], rotation: [0, 0, 0], layerId: 'layer-default', color: '#aabbcc', ...extras } },
    order: ['e1'],
  });
const loose = (doc: CadDocument): Record<string, unknown> => doc as unknown as Record<string, unknown>;
const boxAndCircle = build(['add_box', { size: [2, 3, 4], position: [1, 0, 0] }], ['draw_arc', { center: [0, 0], radius: 5 }]).doc;

describe('serializeDocument / deserializeDocument', () => {
  it('round-trips empty and populated documents exactly in a llull envelope', () => {
    const doc = createEmptyDocument();
    expect(deserializeDocument(serializeDocument(doc))).toEqual(doc);
    const restored = deserializeDocument(serializeDocument(boxAndCircle));
    expect(restored).toEqual(boxAndCircle);
    expect([Object.keys(restored.entities).length, restored.order.length]).toEqual([2, 2]);
    expectDocumentEnvelope(JSON.parse(serializeDocument(doc)) as Record<string, unknown>);
  });

  it.each<[string, RegExp]>([
    ['not-json{', /invalid JSON/i],
    ['42', /root level/i],
    ['"hello"', /root level/i],
    ['null', /root level/i],
    ['[]', /root level/i],
    [JSON.stringify({ format: 'other-app', version: 1, document: {} }), /format/i],
    [JSON.stringify({ version: 1, document: {} }), /format/i],
    [JSON.stringify({ format: 'llull-document', version: 3, document: {} }), /version/i],
    [JSON.stringify({ format: 'llull-document', document: {} }), /version/i],
    [
      JSON.stringify({
        format: 'llull-document',
        version: 1,
        document: { entities: {}, order: [], layers: {}, layerOrder: [], selection: [] },
      }),
      /invalid/i,
    ],
    [envelope({ entities: { 'bad-e': { id: 'bad-e' } }, order: ['bad-e'] }), /invalid/i],
    [envelope({ layers: { 'bad-layer': { id: 'bad-layer' } } }), /invalid/i],
  ])('rejects %s', (json, error) => expect(() => deserializeDocument(json)).toThrow(error));
});

describe('load_document command', () => {
  it('replaces the document, reports counts, affects the loaded order, purely', () => {
    const source = build(['add_box', { size: [1, 1, 1] }], ['draw_arc', { center: [0, 0], radius: 3 }]).doc;
    const json = serializeDocument(source);
    const target = createEmptyDocument();
    const r = execute(target, 'load_document', { json });
    expect(r.affected).toEqual(r.document.order);
    expect(r.document).toEqual(source);
    expect(r.summary).toMatch(/2 entities/);
    expect(r.summary).toMatch(/1 layer/);
    expectPure(target, () => execute(target, 'load_document', { json }));
    const one = execute(target, 'load_document', { json: serializeDocument(build(['add_box', { size: [1, 1, 1] }]).doc) });
    expect(one.summary).toMatch(/1 entity[^i]/);
  });

  it('round-trips a revolution entity', () => {
    const source = build(['revolve_profile', { profile: xy(1, 0, 2, 0, 2, 1, 1, 1), axis: 'z', angle: Math.PI, segments: 16 }]).doc;
    const r = execute(createEmptyDocument(), 'load_document', { json: serializeDocument(source) });
    expect(r.document).toEqual(source);
    expect(r.document.entities[r.affected[0]!]?.kind).toBe('revolution');
  });

  it.each<[string, RegExp]>([
    ['{{bad', /invalid JSON/i],
    [JSON.stringify({ format: 'unknown', version: 1, document: {} }), /format/i],
    [JSON.stringify({ format: 'llull-document', version: 99, document: {} }), /version/i],
    [withEntity('line', { layerId: 'layer-missing' }), /layer-missing/i],
  ])('%s is a graceful no-op', (json, summary) => {
    const doc = createEmptyDocument();
    const r = execute(doc, 'load_document', { json });
    expectNoOp(r, doc);
    expect(r.summary).toMatch(summary);
  });
});

describe('deserializeDocument — entity validation', () => {
  it.each<[string, Record<string, unknown>]>([
    ['text', { content: 'hello', height: 12, font: 'Arial', points: [[0, 0]] }],
    ['rectangle', { width: 10, height: 5 }],
    ['ellipse', { center: [0, 0], radiusX: 3, radiusY: 2 }],
    ['line', { start: [0, 0], end: [1, 1] }],
    ['polyline', { points: xy(0, 0, 1, 1) }],
    ['point', { point: [0, 0] }],
    ['mesh', { vertices: [], faces: [] }],
    ['dimension', { start: [0, 0], end: [10, 0], offset: 5 }],
    ['sphere', { radius: 5 }],
    ['torus', { ringRadius: 4, tubeRadius: 1 }],
    ['cylinder', { radius: 3, height: 10 }],
    ['pyramid', { baseWidth: 4, baseDepth: 3, height: 5 }],
    ['extrusion', { profile: xy(0, 0, 1, 0, 1, 1, 0, 1), depth: 3 }],
  ])('accepts a valid %s', (kind, extras) => expect(deserializeDocument(withEntity(kind, extras)).entities['e1']?.kind).toBe(kind));

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['text', { content: 'hi', height: 0, points: [[0, 0]] }, /height/i],
    ['text', { content: 'hi', height: NaN, points: [[0, 0]] }, /height/i],
    ['donut', {}, /unknown kind/i],
    ['line', { color: 'red' }, /hex color/i],
    ['line', { color: '#abc' }, /hex color/i],
    ['line', { position: [NaN, 0, 0] }, /position/i],
    ['line', { position: [Infinity, 0, 0] }, /position/i],
    ['line', { layerId: 'layer-ghost' }, /layerId.*layer-ghost/i],
    ['box', { size: [0, 1, 1] }, /size/i],
    ['box', { size: [1, -2, 1] }, /size/i],
    ['box', { size: 'large' }, /size/i],
    ['wedge', { size: [2, 0, 3] }, /size/i],
    ['cylinder', { radius: 0, height: 5 }, /radius/i],
    ['cylinder', { radius: 3, height: Infinity }, /height/i],
    ['cone', { radius: 2, height: -1 }, /height/i],
    ['sphere', { radius: -1 }, /radius/i],
    ['torus', { ringRadius: 0, tubeRadius: 1 }, /ringRadius/i],
    ['torus', { ringRadius: 5, tubeRadius: -0.5 }, /tubeRadius/i],
    ['pyramid', { baseWidth: 0, baseDepth: 3, height: 5 }, /baseWidth/i],
    ['pyramid', { baseWidth: 3, baseDepth: -1, height: 5 }, /baseDepth/i],
    ['pyramid', { baseWidth: 3, baseDepth: 3, height: 0 }, /height/i],
    ['extrusion', { profile: xy(0, 0, 1, 0, 1, 1), depth: NaN }, /depth/i],
    ['extrusion', { profile: xy(0, 0, 1, 0, 1, 1), depth: Infinity }, /depth/i],
    ['rectangle', { width: 0, height: 5 }, /width/i],
    ['rectangle', { width: 5, height: -2 }, /height/i],
    ['arc', { center: [0, 0], radius: 0, startAngle: 0, endAngle: Math.PI }, /radius/i],
    ['circle', { center: [0, 0], radius: -3 }, /radius/i],
    ['ellipse', { center: [0, 0], radiusX: 0, radiusY: 3 }, /radiusX/i],
    ['ellipse', { center: [0, 0], radiusX: 3, radiusY: -1 }, /radiusY/i],
  ])('rejects %s %j', (kind, extras, error) => expect(() => deserializeDocument(withEntity(kind, extras))).toThrow(error));
});

describe('deserializeDocument — materials, parameters, back-compat defaults', () => {
  const mat = (m: Record<string, unknown>): string =>
    envelope({ materials: { bad: { density: 1000, color: '#aabbcc', metalness: 0.5, roughness: 0.5, ...m } } });

  it.each<[string, RegExp]>([
    [envelope({ materials: { bad: 'not-an-object' } }), /material/i],
    [mat({ density: 0 }), /density/i],
    [mat({ density: -100 }), /density/i],
    [mat({ color: 'silver' }), /hex color/i],
    [mat({ metalness: 1.5 }), /metalness/i],
    [mat({ metalness: -0.1 }), /metalness/i],
    [mat({ metalness: NaN }), /metalness/i],
    [mat({ roughness: 2.0 }), /roughness/i],
    [mat({ roughness: -0.5 }), /roughness/i],
    [envelope({ parameters: { bad: 'not-an-object' } }), /parameter/i],
    [envelope({ parameters: { width: { name: 42, expression: '10', value: 10 } } }), /name field/i],
    [envelope({ parameters: { width: { name: 'width', expression: 10, value: 10 } } }), /expression/i],
    [envelope({ parameters: { width: { name: 'width', expression: '10', value: 'ten' } } }), /value must be a number/i],
  ])('rejects %s', (json, error) => expect(() => deserializeDocument(json)).toThrow(error));

  it('accepts valid materials and parameters', () => {
    const doc = deserializeDocument(
      envelope({
        materials: { steel: { density: 7850, color: '#808080', metalness: 0.8, roughness: 0.2 } },
        parameters: { width: { name: 'width', expression: '42', value: 42 } },
      }),
    );
    expect(doc.materials['steel']).toBeDefined();
    expect(doc.parameters['width']).toBeDefined();
  });

  it.each<[Record<string, unknown>, Record<string, unknown>]>([
    [
      {},
      {
        parameters: {},
        featureHistory: [],
        animations: {},
        configurations: {},
        materials: {},
        groups: {},
        units: 'mm',
        displayPrecision: 3,
      },
    ],
    [{ units: 'parsec' }, { units: 'mm' }],
    [{ units: 'cm' }, { units: 'cm' }],
    [{ displayPrecision: 6 }, { displayPrecision: 6 }],
    [{ displayPrecision: 1.5 }, { displayPrecision: 3 }],
    [{ displayPrecision: -2 }, { displayPrecision: 3 }],
  ])('fills defaults for %j', (fields, expected) => expect(loose(deserializeDocument(envelope(fields)))).toMatchObject(expected));
});

describe('command guard branches', () => {
  it.each<[number[], string?]>([[[NaN, 1, 1], 'size'], [[1, Infinity, 1]], [[1, 1, -1], 'size']])(
    'add_box size %j is a no-op',
    (size, summary) => {
      const doc = createEmptyDocument();
      expectNoOp(execute(doc, 'add_box', { size }), doc, summary);
    },
  );

  it('delete_entities works on a document without groups', () => {
    const {
      doc,
      ids: [id],
    } = build(['add_box', { size: [1, 1, 1] }]);
    const thin: Partial<CadDocument> = { ...doc };
    delete thin.groups;
    const r = execute(thin as CadDocument, 'delete_entities', { ids: [id] });
    expect(r.document.entities[id!]).toBeUndefined();
    expect(r.document.order).not.toContain(id);
    expect(r.affected).toEqual([id]);
  });
});

function envelope2(mutate: (document: Record<string, unknown>) => void): string {
  const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
  const parsed = JSON.parse(serializeDocument(doc)) as { document: Record<string, unknown> };
  mutate(parsed.document);
  return JSON.stringify({ format: 'llull-document', version: 1, document: parsed.document });
}

describe('load_document rejects malformed documents as a no-op', () => {
  const doc = createEmptyDocument();
  const cases: Array<[string, (d: Record<string, unknown>) => void]> = [
    [
      'null entity',
      (d) => {
        (d['entities'] as Record<string, unknown>)['x'] = null;
      },
    ],
    [
      'entity without position',
      (d) => {
        const e = d['entities'] as Record<string, Record<string, unknown>>;
        delete e[Object.keys(e)[0]!]!['position'];
      },
    ],
    [
      'entity with unknown kind',
      (d) => {
        const e = d['entities'] as Record<string, Record<string, unknown>>;
        e[Object.keys(e)[0]!]!['kind'] = 'warp_drive';
      },
    ],
    [
      'entity with NaN-like string size',
      (d) => {
        const e = d['entities'] as Record<string, Record<string, unknown>>;
        e[Object.keys(e)[0]!]!['size'] = ['a', 'b', 'c'];
      },
    ],
    [
      'order references missing entity',
      (d) => {
        d['order'] = ['ghost'];
      },
    ],
    [
      'selection references missing entity (rejected, not repaired)',
      (d) => {
        d['selection'] = ['ghost'];
      },
    ],
    [
      'entity record key differs from entity.id',
      (d) => {
        const e = d['entities'] as Record<string, Record<string, unknown>>;
        e[Object.keys(e)[0]!]!['id'] = 'other-id';
      },
    ],
    [
      'order contains duplicate ids',
      (d) => {
        const order = d['order'] as string[];
        d['order'] = [...order, ...order];
      },
    ],
    [
      'featureHistory step malformed',
      (d) => {
        d['featureHistory'] = [null];
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    it(label, () => {
      expectNoOp(execute(doc, 'load_document', { json: envelope2(mutate) }), doc);
    });
  }
});

describe('load_document back-compat defaults', () => {
  it('replaces wrong-typed optional fields with empty defaults instead of crashing', () => {
    const json = envelope2((d) => {
      d['featureHistory'] = 'nope';
      d['parameters'] = [1, 2];
    });
    const result = execute(createEmptyDocument(), 'load_document', { json });
    expect(result.affected.length).toBeGreaterThan(0);
    expect(result.document.featureHistory).toEqual([]);
    expect(result.document.parameters).toEqual({});
  });
});

const base = (): Record<string, unknown> => JSON.parse(JSON.stringify(createEmptyDocument())) as Record<string, unknown>;

const withSection = (section: string, value: unknown): string[] => validateDocumentValues({ ...base(), [section]: value });

const mateRef = { instanceId: 'inst-1', frame: 'origin' };
const joint = { id: 'j1', kind: 'revolute', a: mateRef, b: mateRef, axis: 'z', angle: 0 };

describe('validateDocumentValues section guards', () => {
  it('accepts an empty document', () => {
    expect(validateDocumentValues(base())).toEqual([]);
  });
  it('accepts well-formed joints, constraints, drive relations and recipes', () => {
    expect(withSection('joints', { j1: joint })).toEqual([]);
    expect(withSection('joints', { j2: { ...joint, id: 'j2', kind: 'prismatic', axis: [1, 0, 0], displacement: 2 } })).toEqual([]);
    expect(
      withSection('constraints', {
        c1: { id: 'c1', kind: 'distance', a: { entityId: 'e1', kind: 'start' }, b: { entityId: 'e2' }, value: 5 },
      }),
    ).toEqual([]);
    expect(withSection('driveRelations', { d1: { id: 'd1', driver: 'j1', driven: 'j2', ratio: 2, offset: 0.5 } })).toEqual([]);
    expect(withSection('recipes', { r1: { name: 'r1', steps: [{ id: 'step-1', name: 'add_box' }] } })).toEqual([]);
  });
  it.each([
    ['joint is not an object', 'joints', { j1: 5 }, 'is not an object'],
    ['joint kind unknown', 'joints', { j1: { ...joint, kind: 'ball' } }, "unknown kind 'ball'"],
    ['joint mate ref missing', 'joints', { j1: { ...joint, a: 3 } }, 'a must be an object'],
    ['joint mate instanceId empty', 'joints', { j1: { ...joint, b: { instanceId: '' } } }, 'b.instanceId must be a non-empty string'],
    ['joint mate frame invalid', 'joints', { j1: { ...joint, a: { instanceId: 'i', frame: 'diagonal' } } }, 'a.frame must be'],
    ['joint axis invalid', 'joints', { j1: { ...joint, axis: [1, 0] } }, 'axis must be'],
    ['revolute angle not finite', 'joints', { j1: { ...joint, angle: 'x' } }, 'angle must be a finite number'],
    ['prismatic displacement missing', 'joints', { j1: { ...joint, kind: 'prismatic' } }, 'displacement must be a finite number'],
    ['constraint not an object', 'constraints', { c1: null }, 'is not an object'],
    ['constraint kind unknown', 'constraints', { c1: { id: 'c1', kind: 'warp', a: {}, b: {} } }, "unknown kind 'warp'"],
    [
      'constraint ref entityId missing',
      'constraints',
      { c1: { id: 'c1', kind: 'coincident', a: {}, b: { entityId: 'e' } } },
      'a.entityId must be a non-empty string',
    ],
    [
      'constraint ref kind invalid',
      'constraints',
      { c1: { id: 'c1', kind: 'coincident', a: { entityId: 'e', kind: 'top' }, b: { entityId: 'e' } } },
      'a.kind must be start|end|center|mid',
    ],
    [
      'distance constraint value missing',
      'constraints',
      { c1: { id: 'c1', kind: 'distance', a: { entityId: 'e' }, b: { entityId: 'f' } } },
      'value must be a number or string',
    ],
    ['drive relation not an object', 'driveRelations', { d1: 1 }, 'is not an object'],
    [
      'drive relation driver empty',
      'driveRelations',
      { d1: { id: 'd1', driver: '', driven: 'b', ratio: 1 } },
      'driver must be a non-empty string',
    ],
    [
      'drive relation ratio not finite',
      'driveRelations',
      { d1: { id: 'd1', driver: 'a', driven: 'b', ratio: 'fast' } },
      'ratio must be a finite number',
    ],
    [
      'drive relation offset not finite',
      'driveRelations',
      { d1: { id: 'd1', driver: 'a', driven: 'b', ratio: 1, offset: 'x' } },
      'offset must be a finite number',
    ],
    ['recipe not an object', 'recipes', { r1: 'nope' }, 'is not an object'],
    ['recipe steps not an array', 'recipes', { r1: { name: 'r1', steps: 3 } }, 'steps must be an array'],
    ['recipe step malformed', 'recipes', { r1: { name: 'r1', steps: [{ id: 'step-1' }] } }, 'steps[0].name must be a string'],
  ])('rejects %s', (_label, section, value, fragment) => {
    const errors = withSection(section, value);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain(fragment);
  });
});
