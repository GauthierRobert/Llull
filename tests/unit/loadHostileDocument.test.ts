import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence/serialization';

type Raw = Record<string, unknown>;

function built(): CadDocument {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
  doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
  return doc;
}

/** Serialize `doc`, let `edit` mutate the raw document record, return the JSON string. */
function tampered(edit: (raw: Raw) => void, doc: CadDocument = built()): string {
  const envelope = JSON.parse(serializeDocument(doc)) as { document: Raw };
  edit(envelope.document);
  return JSON.stringify(envelope);
}

function expectRejected(json: string, fragment: string): void {
  const doc = createEmptyDocument();
  const result = execute(doc, 'load_document', { json });
  expect(result.document).toBe(doc);
  expect(result.affected).toEqual([]);
  expect(result.summary).toContain(fragment);
  expect(() => deserializeDocument(json)).toThrow(fragment);
}

const entityOf = (raw: Raw, index = 0): Raw => {
  const entities = raw['entities'] as Record<string, Raw>;
  return entities[Object.keys(entities)[index] as string] as Raw;
};

const BASE = { position: [0, 0, 0], rotation: [0, 0, 0], layerId: 'layer-default', color: '#112233' };
const withEntity = (id: string, body: Raw): ((raw: Raw) => void) => {
  return (raw) => {
    (raw['entities'] as Raw)[id] = { id, ...BASE, ...body };
    (raw['order'] as string[]).push(id);
  };
};
const SQUARE = [
  [0, 0],
  [1, 0],
  [1, 1],
];

describe('load_document: per-kind entity checks', () => {
  const cases: ReadonlyArray<[string, Raw, string]> = [
    ['revolution segments too large', { kind: 'revolution', profile: SQUARE, axis: [0, 1, 0], angle: 6, segments: 2_000_000 }, 'segments'],
    ['revolution segments below 3', { kind: 'revolution', profile: SQUARE, axis: [0, 1, 0], angle: 6, segments: 2 }, 'segments'],
    ['revolution zero axis', { kind: 'revolution', profile: SQUARE, axis: [0, 0, 0], angle: 6, segments: 8 }, 'axis'],
    ['revolution angle 0', { kind: 'revolution', profile: SQUARE, axis: [0, 1, 0], angle: 0, segments: 8 }, 'angle'],
    ['revolution angle > 2pi', { kind: 'revolution', profile: SQUARE, axis: [0, 1, 0], angle: 7, segments: 8 }, 'angle'],
    ['revolution short profile', { kind: 'revolution', profile: [[0, 0]], axis: [0, 1, 0], angle: 6, segments: 8 }, 'profile'],
    ['extrusion bad profile', { kind: 'extrusion', profile: [[0, 0], 'x', [1, 1]], depth: 1 }, 'profile'],
    ['extrusion missing profile', { kind: 'extrusion', depth: 1 }, 'profile'],
    ['polyline bad points', { kind: 'polyline', points: [[0, 0], [1]], closed: false }, 'points'],
    ['spline missing points', { kind: 'spline', closed: false }, 'points'],
    ['polyline closed not boolean', { kind: 'polyline', points: SQUARE, closed: 'yes' }, 'closed'],
    ['line bad end', { kind: 'line', start: [0, 0], end: 'x' }, 'end'],
    ['arc non-finite angle', { kind: 'arc', center: [0, 0], radius: 1, startAngle: 'a', endAngle: 1 }, 'startAngle'],
    ['circle bad center', { kind: 'circle', center: [0], radius: 1 }, 'center'],
    ['ellipse bad center', { kind: 'ellipse', center: 5, radiusX: 1, radiusY: 1 }, 'center'],
    ['text numeric content', { kind: 'text', content: 5, height: 1 }, 'content'],
    ['text empty content', { kind: 'text', content: '', height: 1 }, 'content'],
    ['text bad anchor', { kind: 'text', content: 'a', height: 1, anchor: 'top' }, 'anchor'],
    ['dimension bad kind', { kind: 'dimension', dimensionKind: 'x', entityIds: [] }, 'dimensionKind'],
    ['dimension bad entityIds', { kind: 'dimension', dimensionKind: 'linear', entityIds: [1] }, 'entityIds'],
    ['mesh bad positions', { kind: 'mesh', mesh: { positions: ['a'], indices: [] } }, 'mesh'],
    ['mesh index out of range', { kind: 'mesh', mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 9] } }, 'mesh'],
    ['mesh missing', { kind: 'mesh' }, 'mesh'],
    ['bad name type', { kind: 'point', name: 3 }, 'name'],
    ['bad tags type', { kind: 'point', tags: 'x' }, 'tags'],
  ];
  it.each(cases)('rejects %s', (_label, body, fragment) => {
    expectRejected(tampered(withEntity('hostile', body)), fragment);
  });

  it('loads valid instances of the newly checked kinds', () => {
    const json = tampered((raw) => {
      withEntity('rev', { kind: 'revolution', profile: SQUARE, axis: [0, 1, 0], angle: Math.PI * 2, segments: 24 })(raw);
      withEntity('txt', { kind: 'text', content: 'hi', height: 2, anchor: 'center' })(raw);
      withEntity('pl', { kind: 'polyline', points: SQUARE, closed: true })(raw);
      withEntity('pt', { kind: 'point' })(raw);
      withEntity('ms', { kind: 'mesh', mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] } })(raw);
      withEntity('dm', { kind: 'dimension', dimensionKind: 'radial', entityIds: ['rev'] })(raw);
    });
    expect(Object.keys(deserializeDocument(json).entities)).toContain('rev');
  });
});

describe('load_document: order integrity and corruption', () => {
  it('repairs an order that omits entities, so none is hidden from order-driven scans', () => {
    const doc = built();
    const json = tampered((raw) => {
      (raw['order'] as string[]).pop();
    }, doc);
    expect(deserializeDocument(json).order).toEqual(doc.order);
    expect(deserializeDocument(tampered((raw) => void (raw['order'] = []), doc)).order).toEqual(doc.order);
  });
  it('runs the corruption check in deserializeDocument for every entity (hidden by order: [])', () => {
    const json = tampered((raw) => {
      raw['order'] = [];
      entityOf(raw)['position'] = [0, 0];
    });
    expect(() => deserializeDocument(json)).toThrow();
  });
  it('rejects null smuggled into an entity vector', () => {
    expectRejected(
      tampered((raw) => {
        entityOf(raw)['size'] = [1, null, 1];
      }),
      'size',
    );
  });
});

describe('load_document: step counter', () => {
  it('rejects an unsafe nextStepNumber', () => {
    expectRejected(
      tampered((raw) => {
        raw['nextStepNumber'] = 2 ** 53 + 2;
      }),
      'nextStepNumber',
    );
  });
  it.each([0, -3, 1.5, '4'])('rejects nextStepNumber %s', (value) => {
    expectRejected(
      tampered((raw) => {
        raw['nextStepNumber'] = value;
      }),
      'nextStepNumber',
    );
  });
  it('rejects an entity id carrying an unsafe step number', () => {
    expectRejected(tampered(withEntity('box-99999999999999999999.1', { kind: 'point' })), 'step number');
  });
  it('execute mints distinct ids even if the counter is unsafe', () => {
    const base = { ...createEmptyDocument(), nextStepNumber: 2 ** 53 + 2 };
    const first = execute(base, 'add_box', { size: [1, 1, 1] });
    expect(first.document).toBe(base);
  });
});

describe('load_document: feature history', () => {
  const step = (id: string, name = 'add_box', extra: Raw = {}): Raw => ({ id, name, params: { size: [1, 1, 1] }, affected: [], ...extra });
  const withHistory = (history: unknown[]): string =>
    tampered((raw) => {
      raw['featureHistory'] = history;
    }, createEmptyDocument());
  it('rejects duplicate step ids', () => expectRejected(withHistory([step('step-1'), step('step-1')]), 'duplicate'));
  it('rejects unknown commands', () => expectRejected(withHistory([step('step-1', 'no_such_command')]), 'unknown command'));
  it.each(['replay_history', 'delete_step', 'load_document'])('rejects history-control command %s', (name) =>
    expectRejected(withHistory([step('step-1', name)]), 'edits the history itself'),
  );
  it('still reads legacy recorded meta/read-only steps', () => {
    expect(
      deserializeDocument(withHistory([step('step-1', 'set_camera'), step('step-2', 'measure_distance')])).featureHistory,
    ).toHaveLength(2);
  });
  it('rejects non-object params', () => expectRejected(withHistory([step('step-1', 'add_box', { params: 5 })]), 'params'));
  it('rejects non-string affected', () => expectRejected(withHistory([step('step-1', 'add_box', { affected: [1] })]), 'affected'));
  it('rejects non-boolean suppressed', () => expectRejected(withHistory([step('step-1', 'add_box', { suppressed: 'no' })]), 'suppressed'));
  it('accepts a well-formed step', () => {
    expect(deserializeDocument(withHistory([step('step-1', 'add_box', { suppressed: false })])).featureHistory).toHaveLength(1);
  });
});

describe('load_document: groups, animations, configurations, components', () => {
  const emptyEdit = (key: string, value: unknown): string =>
    tampered((raw) => {
      raw[key] = value;
    }, createEmptyDocument());
  it('rejects a group without memberIds array', () => expectRejected(emptyEdit('groups', { g: { id: 'g', name: 'g' } }), 'group'));
  it('rejects a group with non-string members', () =>
    expectRejected(emptyEdit('groups', { g: { id: 'g', name: 'g', memberIds: [1] } }), 'memberIds'));
  it('rejects a malformed animation', () => expectRejected(emptyEdit('animations', { a: { id: 'a', axis: 'x' } }), 'animation'));
  it('rejects a malformed configuration', () =>
    expectRejected(emptyEdit('configurations', { c: { name: 'c', parameterValues: 5 } }), 'configuration'));
  it('rejects a component without entities', () => expectRejected(emptyEdit('components', { c: { id: 'c', name: 'c' } }), 'component'));
  it('rejects a component entity that is not an object (cycle search cannot throw)', () =>
    expectRejected(emptyEdit('components', { c: { id: 'c', name: 'c', entities: { x: 5 }, order: ['x'] } }), 'component'));
  it('accepts well-formed ones', () => {
    const json = emptyEdit('groups', { g: { id: 'g', name: 'g', memberIds: [] } });
    expect(deserializeDocument(json).groups['g']).toBeDefined();
  });
});

describe('load_document: prototype keys and layerOrder', () => {
  it.each(['__proto__', 'constructor', 'toString'])('rejects entity key %s', (key) => {
    const json = tampered((raw) => {
      const entities = raw['entities'] as Raw;
      Object.defineProperty(entities, key, {
        value: { id: key, kind: 'point', ...BASE },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    });
    expect(json).toContain(`"${key}":{`);
    expectRejected(json, key);
  });
  it('rejects a layers key that is a prototype key', () => {
    const json = tampered((raw) => {
      (raw['layers'] as Raw)['constructor'] = { id: 'constructor', name: 'x', visible: true, locked: false };
    });
    expectRejected(json, 'constructor');
  });
  it('rejects a layerOrder id that is not a layer', () => {
    expectRejected(
      tampered((raw) => {
        (raw['layerOrder'] as string[]).push('ghost');
      }),
      'layerOrder',
    );
  });
  it('repairs a layer missing from layerOrder by appending it', () => {
    const json = tampered((raw) => {
      (raw['layers'] as Raw)['extra'] = { id: 'extra', name: 'x', visible: true, locked: false };
    });
    expect(deserializeDocument(json).layerOrder).toContain('extra');
  });
  it('repairs duplicate layerOrder entries', () => {
    const json = tampered((raw) => {
      raw['layerOrder'] = [...(raw['layerOrder'] as string[]), ...(raw['layerOrder'] as string[])];
    });
    expect(deserializeDocument(json).layerOrder).toHaveLength(1);
  });
});
