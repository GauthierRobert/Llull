import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence';
import { __resetIdCounter } from '@lib/id';

// ---------------------------------------------------------------------------
// Helpers — build minimal valid envelopes without going through commands
// (needed to inject edge-case entity shapes that commands would reject)
// ---------------------------------------------------------------------------

/** Minimum valid camera state accepted by validateCamera. */
const VALID_CAMERA = {
  target: [0, 0, 0],
  azimuth: 0,
  polar: Math.PI / 4,
  distance: 10,
};

/** Minimum valid layer accepted by validateLayer. */
const DEFAULT_LAYER = { id: 'layer-default', name: 'Default', visible: true, locked: false };

/**
 * Build a minimal valid llull-document v1 envelope, optionally overriding document fields.
 * The `entities` and `layers` defaults are consistent (entity uses 'layer-default').
 */
function makeEnvelope(
  docOverride: Record<string, unknown> = {},
  entityOverrides: Record<string, unknown> = {},
): string {
  const base: Record<string, unknown> = {
    entities: {},
    order: [],
    layers: { 'layer-default': DEFAULT_LAYER },
    layerOrder: ['layer-default'],
    selection: [],
    camera: VALID_CAMERA,
    ...docOverride,
  };
  return JSON.stringify({
    format: 'llull-document',
    version: 1,
    document: { ...base, ...entityOverrides },
  });
}

/**
 * Build a valid entity record of the given kind with the supplied extra fields.
 * All base fields (id, kind, position, rotation, layerId, color) are pre-filled
 * with valid defaults so tests only need to supply the fields they want to break.
 */
function validEntityBase(id: string, kind: string, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#aabbcc',
    ...extras,
  };
}

describe('serializeDocument / deserializeDocument', () => {
  beforeEach(() => __resetIdCounter());

  it('round-trips an empty document exactly', () => {
    const doc = createEmptyDocument();
    const result = deserializeDocument(serializeDocument(doc));
    expect(result).toEqual(doc);
  });

  it('round-trips a document with a box and a circle entity', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 3, 4], position: [1, 0, 0] }).document;
    doc = execute(doc, 'draw_circle', { center: [0, 0], radius: 5 }).document;

    const serialized = serializeDocument(doc);
    const restored = deserializeDocument(serialized);

    expect(restored).toEqual(doc);
    expect(Object.keys(restored.entities)).toHaveLength(2);
    expect(restored.order).toHaveLength(2);
  });

  it('produces a string that contains the envelope fields', () => {
    const doc = createEmptyDocument();
    const json = serializeDocument(doc);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed['format']).toBe('llull-document');
    expect(parsed['version']).toBe(1);
    expect(parsed['document']).toBeDefined();
  });

  it('throws on invalid JSON', () => {
    expect(() => deserializeDocument('not-json{')).toThrow(/invalid JSON/i);
  });

  it('throws when valid JSON is not an object at the root', () => {
    // These parse successfully but are not records — the root-level guard must reject them.
    expect(() => deserializeDocument('42')).toThrow(/root level/i);
    expect(() => deserializeDocument('"hello"')).toThrow(/root level/i);
    expect(() => deserializeDocument('null')).toThrow(/root level/i);
    expect(() => deserializeDocument('[]')).toThrow(/root level/i);
  });

  it('throws on wrong format field', () => {
    const bad = JSON.stringify({ format: 'other-app', version: 1, document: {} });
    expect(() => deserializeDocument(bad)).toThrow(/format/i);
  });

  it('throws on missing format field', () => {
    const bad = JSON.stringify({ version: 1, document: {} });
    expect(() => deserializeDocument(bad)).toThrow(/format/i);
  });

  it('throws on wrong version', () => {
    const bad = JSON.stringify({ format: 'llull-document', version: 2, document: {} });
    expect(() => deserializeDocument(bad)).toThrow(/version/i);
  });

  it('throws on missing version field', () => {
    const bad = JSON.stringify({ format: 'llull-document', document: {} });
    expect(() => deserializeDocument(bad)).toThrow(/version/i);
  });

  it('throws when document is structurally invalid (missing camera)', () => {
    const env = {
      format: 'llull-document',
      version: 1,
      document: {
        entities: {},
        order: [],
        layers: {},
        layerOrder: [],
        selection: [],
        // camera intentionally omitted
      },
    };
    expect(() => deserializeDocument(JSON.stringify(env))).toThrow(/invalid/i);
  });

  it('throws when entities contain a malformed entry', () => {
    const doc = createEmptyDocument();
    const env = {
      format: 'llull-document',
      version: 1,
      document: {
        ...doc,
        entities: { 'bad-e': { id: 'bad-e' } }, // missing kind, position, etc.
        order: ['bad-e'],
      },
    };
    expect(() => deserializeDocument(JSON.stringify(env))).toThrow(/invalid/i);
  });

  it('throws when layers contain a malformed entry', () => {
    const doc = createEmptyDocument();
    const env = {
      format: 'llull-document',
      version: 1,
      document: {
        ...doc,
        layers: { 'bad-layer': { id: 'bad-layer' } }, // missing name, visible, locked
      },
    };
    expect(() => deserializeDocument(JSON.stringify(env))).toThrow(/invalid/i);
  });
});

describe('load_document command', () => {
  beforeEach(() => __resetIdCounter());

  it('happy path: replaces the document and reports entity/layer counts', () => {
    let sourceDoc = createEmptyDocument();
    sourceDoc = execute(sourceDoc, 'add_box', { size: [1, 1, 1] }).document;
    sourceDoc = execute(sourceDoc, 'draw_circle', { center: [0, 0], radius: 3 }).document;

    const json = serializeDocument(sourceDoc);
    const emptyDoc = createEmptyDocument();
    const result = execute(emptyDoc, 'load_document', { json });

    expect(result.affected).toEqual(sourceDoc.order);
    expect(result.document).toEqual(sourceDoc);
    expect(result.summary).toMatch(/2 entities/);
    expect(result.summary).toMatch(/1 layer/);
  });

  it('affected ids equal the loaded document order', () => {
    let sourceDoc = createEmptyDocument();
    sourceDoc = execute(sourceDoc, 'add_box', { size: [2, 2, 2] }).document;

    const json = serializeDocument(sourceDoc);
    const result = execute(createEmptyDocument(), 'load_document', { json });

    expect(result.affected).toEqual(result.document.order);
  });

  it('failure path: invalid JSON is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'load_document', { json: '{{bad' });

    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toMatch(/invalid JSON/i);
  });

  it('failure path: wrong format is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const bad = JSON.stringify({ format: 'unknown', version: 1, document: {} });
    const result = execute(doc, 'load_document', { json: bad });

    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toMatch(/format/i);
  });

  it('failure path: wrong version is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const bad = JSON.stringify({ format: 'llull-document', version: 99, document: {} });
    const result = execute(doc, 'load_document', { json: bad });

    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toMatch(/version/i);
  });

  it('is pure — the input document is never mutated', () => {
    let sourceDoc = createEmptyDocument();
    sourceDoc = execute(sourceDoc, 'add_box', { size: [1, 2, 3] }).document;
    const json = serializeDocument(sourceDoc);

    const targetDoc = createEmptyDocument();
    const snapshot = JSON.stringify(targetDoc);
    execute(targetDoc, 'load_document', { json });
    expect(JSON.stringify(targetDoc)).toBe(snapshot);
  });

  it('summary uses singular "entity" when exactly one entity is loaded', () => {
    let sourceDoc = createEmptyDocument();
    sourceDoc = execute(sourceDoc, 'add_box', { size: [1, 1, 1] }).document;

    const json = serializeDocument(sourceDoc);
    const result = execute(createEmptyDocument(), 'load_document', { json });

    expect(result.summary).toMatch(/1 entity[^i]/);
  });
});

// ---------------------------------------------------------------------------
// KI6 — Validation branches: entity kind-specific guards
// These tests target the switch/case branches in validateEntityValue that were
// previously uncovered: text (line 232), default (line 235).
// ---------------------------------------------------------------------------

describe('deserializeDocument — entity kind-specific validation', () => {
  beforeEach(() => __resetIdCounter());

  // ── text — valid passes, invalid height fails ────────────────────────────

  it('accepts a valid text entity (height > 0) — covers break in text case', () => {
    const entity = validEntityBase('t1', 'text', {
      content: 'hello',
      height: 12,
      font: 'Arial',
      points: [[0, 0]],
    });
    const json = makeEnvelope({
      entities: { t1: entity },
      order: ['t1'],
    });
    const restored = deserializeDocument(json);
    expect(restored.entities['t1']).toBeDefined();
    expect((restored.entities['t1'] as unknown as Record<string, unknown>)['kind']).toBe('text');
  });

  it('throws on text entity with height <= 0', () => {
    const entity = validEntityBase('t1', 'text', { content: 'hi', height: 0, points: [[0, 0]] });
    const json = makeEnvelope({ entities: { t1: entity }, order: ['t1'] });
    expect(() => deserializeDocument(json)).toThrow(/height/i);
  });

  it('throws on text entity with non-finite height (NaN)', () => {
    const entity = validEntityBase('t1', 'text', { content: 'hi', height: NaN, points: [[0, 0]] });
    const json = makeEnvelope({ entities: { t1: entity }, order: ['t1'] });
    expect(() => deserializeDocument(json)).toThrow(/height/i);
  });

  // ── rectangle — valid passes (covers break line 216-217) ──────────────────

  it('accepts a valid rectangle entity — covers break in rectangle case', () => {
    const entity = validEntityBase('rect1', 'rectangle', { width: 10, height: 5 });
    const json = makeEnvelope({ entities: { rect1: entity }, order: ['rect1'] });
    const restored = deserializeDocument(json);
    expect((restored.entities['rect1'] as unknown as Record<string, unknown>)['kind']).toBe('rectangle');
  });

  // ── ellipse — valid passes (covers break line 225-226) ────────────────────

  it('accepts a valid ellipse entity — covers break in ellipse case', () => {
    const entity = validEntityBase('el1', 'ellipse', { center: [0, 0], radiusX: 3, radiusY: 2 });
    const json = makeEnvelope({ entities: { el1: entity }, order: ['el1'] });
    const restored = deserializeDocument(json);
    expect((restored.entities['el1'] as unknown as Record<string, unknown>)['kind']).toBe('ellipse');
  });

  // ── default case — line, polyline, point, spline, dimension, mesh ─────────

  it('accepts a line entity — covers default break (no numeric invariants)', () => {
    const entity = validEntityBase('l1', 'line', {
      start: [0, 0],
      end: [1, 1],
    });
    const json = makeEnvelope({ entities: { l1: entity }, order: ['l1'] });
    const restored = deserializeDocument(json);
    expect((restored.entities['l1'] as unknown as Record<string, unknown>)['kind']).toBe('line');
  });

  it('accepts a polyline entity — covers default break', () => {
    const entity = validEntityBase('p1', 'polyline', { points: [[0, 0], [1, 1]] });
    const json = makeEnvelope({ entities: { p1: entity }, order: ['p1'] });
    const restored = deserializeDocument(json);
    expect((restored.entities['p1'] as unknown as Record<string, unknown>)['kind']).toBe('polyline');
  });

  it('accepts a point entity — covers default break', () => {
    const entity = validEntityBase('pt1', 'point', { point: [0, 0] });
    const json = makeEnvelope({ entities: { pt1: entity }, order: ['pt1'] });
    const restored = deserializeDocument(json);
    expect((restored.entities['pt1'] as unknown as Record<string, unknown>)['kind']).toBe('point');
  });

  it('accepts a mesh entity — covers default break', () => {
    const entity = validEntityBase('m1', 'mesh', { vertices: [], faces: [] });
    const json = makeEnvelope({ entities: { m1: entity }, order: ['m1'] });
    const restored = deserializeDocument(json);
    expect((restored.entities['m1'] as unknown as Record<string, unknown>)['kind']).toBe('mesh');
  });

  it('accepts a dimension entity — covers default break', () => {
    const entity = validEntityBase('d1', 'dimension', {
      start: [0, 0],
      end: [10, 0],
      offset: 5,
    });
    const json = makeEnvelope({ entities: { d1: entity }, order: ['d1'] });
    const restored = deserializeDocument(json);
    expect((restored.entities['d1'] as unknown as Record<string, unknown>)['kind']).toBe('dimension');
  });

  // ── unknown kind ──────────────────────────────────────────────────────────

  it('throws on entity with unknown kind', () => {
    const entity = validEntityBase('u1', 'donut', {});
    const json = makeEnvelope({ entities: { u1: entity }, order: ['u1'] });
    expect(() => deserializeDocument(json)).toThrow(/unknown kind/i);
  });

  // ── bad hex color on entity ───────────────────────────────────────────────

  it('throws on entity with bad hex color (not #rrggbb)', () => {
    const entity = validEntityBase('b1', 'line', { color: 'red' });
    const json = makeEnvelope({ entities: { b1: entity }, order: ['b1'] });
    expect(() => deserializeDocument(json)).toThrow(/hex color/i);
  });

  it('throws on entity with 3-digit hex color (#rgb not accepted)', () => {
    const entity = validEntityBase('b2', 'line', { color: '#abc' });
    const json = makeEnvelope({ entities: { b2: entity }, order: ['b2'] });
    expect(() => deserializeDocument(json)).toThrow(/hex color/i);
  });

  // ── NaN/Infinity in coordinates ───────────────────────────────────────────

  it('throws on entity with NaN in position', () => {
    const entity = validEntityBase('nan1', 'line', { position: [NaN, 0, 0] });
    const json = makeEnvelope({ entities: { nan1: entity }, order: ['nan1'] });
    expect(() => deserializeDocument(json)).toThrow(/position/i);
  });

  it('throws on entity with Infinity in position', () => {
    const entity = validEntityBase('inf1', 'line', { position: [Infinity, 0, 0] });
    const json = makeEnvelope({ entities: { inf1: entity }, order: ['inf1'] });
    expect(() => deserializeDocument(json)).toThrow(/position/i);
  });

  // ── box/wedge size validations ────────────────────────────────────────────

  it('throws on box entity with a size[i] = 0', () => {
    const entity = validEntityBase('bx1', 'box', { size: [0, 1, 1] });
    const json = makeEnvelope({ entities: { bx1: entity }, order: ['bx1'] });
    expect(() => deserializeDocument(json)).toThrow(/size/i);
  });

  it('throws on box entity with a negative size component', () => {
    const entity = validEntityBase('bx2', 'box', { size: [1, -2, 1] });
    const json = makeEnvelope({ entities: { bx2: entity }, order: ['bx2'] });
    expect(() => deserializeDocument(json)).toThrow(/size/i);
  });

  it('throws on box entity with non-array size', () => {
    const entity = validEntityBase('bx3', 'box', { size: 'large' });
    const json = makeEnvelope({ entities: { bx3: entity }, order: ['bx3'] });
    expect(() => deserializeDocument(json)).toThrow(/size/i);
  });

  it('throws on wedge entity with a size component <= 0', () => {
    const entity = validEntityBase('wdg1', 'wedge', { size: [2, 0, 3] });
    const json = makeEnvelope({ entities: { wdg1: entity }, order: ['wdg1'] });
    expect(() => deserializeDocument(json)).toThrow(/size/i);
  });

  // ── cylinder / cone validations ───────────────────────────────────────────

  it('throws on cylinder entity with radius = 0', () => {
    const entity = validEntityBase('cy1', 'cylinder', { radius: 0, height: 5 });
    const json = makeEnvelope({ entities: { cy1: entity }, order: ['cy1'] });
    expect(() => deserializeDocument(json)).toThrow(/radius/i);
  });

  it('throws on cylinder entity with non-finite height (Infinity)', () => {
    const entity = validEntityBase('cy2', 'cylinder', { radius: 3, height: Infinity });
    const json = makeEnvelope({ entities: { cy2: entity }, order: ['cy2'] });
    expect(() => deserializeDocument(json)).toThrow(/height/i);
  });

  it('throws on cone entity with height <= 0', () => {
    const entity = validEntityBase('co1', 'cone', { radius: 2, height: -1 });
    const json = makeEnvelope({ entities: { co1: entity }, order: ['co1'] });
    expect(() => deserializeDocument(json)).toThrow(/height/i);
  });

  // ── sphere validation ─────────────────────────────────────────────────────

  it('throws on sphere entity with radius <= 0', () => {
    const entity = validEntityBase('sp1', 'sphere', { radius: -1 });
    const json = makeEnvelope({ entities: { sp1: entity }, order: ['sp1'] });
    expect(() => deserializeDocument(json)).toThrow(/radius/i);
  });

  // ── torus validation ──────────────────────────────────────────────────────

  it('throws on torus entity with ringRadius = 0', () => {
    const entity = validEntityBase('to1', 'torus', { ringRadius: 0, tubeRadius: 1 });
    const json = makeEnvelope({ entities: { to1: entity }, order: ['to1'] });
    expect(() => deserializeDocument(json)).toThrow(/ringRadius/i);
  });

  it('throws on torus entity with tubeRadius <= 0', () => {
    const entity = validEntityBase('to2', 'torus', { ringRadius: 5, tubeRadius: -0.5 });
    const json = makeEnvelope({ entities: { to2: entity }, order: ['to2'] });
    expect(() => deserializeDocument(json)).toThrow(/tubeRadius/i);
  });

  it('accepts a valid sphere entity — covers break in sphere case', () => {
    const entity = validEntityBase('sp2', 'sphere', { radius: 5 });
    const json = makeEnvelope({ entities: { sp2: entity }, order: ['sp2'] });
    const restored = deserializeDocument(json);
    expect((restored.entities['sp2'] as unknown as Record<string, unknown>)['kind']).toBe('sphere');
  });

  it('accepts a valid torus entity — covers break in torus case', () => {
    const entity = validEntityBase('to3', 'torus', { ringRadius: 4, tubeRadius: 1 });
    const json = makeEnvelope({ entities: { to3: entity }, order: ['to3'] });
    const restored = deserializeDocument(json);
    expect((restored.entities['to3'] as unknown as Record<string, unknown>)['kind']).toBe('torus');
  });

  it('accepts a valid cylinder entity — covers break in cylinder/cone case', () => {
    const entity = validEntityBase('cy3', 'cylinder', { radius: 3, height: 10 });
    const json = makeEnvelope({ entities: { cy3: entity }, order: ['cy3'] });
    const restored = deserializeDocument(json);
    expect((restored.entities['cy3'] as unknown as Record<string, unknown>)['kind']).toBe('cylinder');
  });

  // ── pyramid validation ────────────────────────────────────────────────────

  it('throws on pyramid entity with baseWidth = 0', () => {
    const entity = validEntityBase('py1', 'pyramid', { baseWidth: 0, baseDepth: 3, height: 5 });
    const json = makeEnvelope({ entities: { py1: entity }, order: ['py1'] });
    expect(() => deserializeDocument(json)).toThrow(/baseWidth/i);
  });

  it('throws on pyramid entity with baseDepth <= 0', () => {
    const entity = validEntityBase('py2', 'pyramid', { baseWidth: 3, baseDepth: -1, height: 5 });
    const json = makeEnvelope({ entities: { py2: entity }, order: ['py2'] });
    expect(() => deserializeDocument(json)).toThrow(/baseDepth/i);
  });

  it('throws on pyramid entity with height = 0', () => {
    const entity = validEntityBase('py3', 'pyramid', { baseWidth: 3, baseDepth: 3, height: 0 });
    const json = makeEnvelope({ entities: { py3: entity }, order: ['py3'] });
    expect(() => deserializeDocument(json)).toThrow(/height/i);
  });

  it('accepts a valid pyramid entity — covers break in pyramid case', () => {
    const entity = validEntityBase('py4', 'pyramid', { baseWidth: 4, baseDepth: 3, height: 5 });
    const json = makeEnvelope({ entities: { py4: entity }, order: ['py4'] });
    const restored = deserializeDocument(json);
    expect((restored.entities['py4'] as unknown as Record<string, unknown>)['kind']).toBe('pyramid');
  });

  // ── extrusion — valid passes + invalid depth ──────────────────────────────

  it('accepts a valid extrusion entity — covers break in extrusion case', () => {
    const entity = validEntityBase('ex1', 'extrusion', {
      profile: [[0, 0], [1, 0], [1, 1], [0, 1]],
      depth: 3,
    });
    const json = makeEnvelope({ entities: { ex1: entity }, order: ['ex1'] });
    const restored = deserializeDocument(json);
    expect((restored.entities['ex1'] as unknown as Record<string, unknown>)['kind']).toBe('extrusion');
  });

  it('throws on extrusion entity with NaN depth', () => {
    const entity = validEntityBase('ex2', 'extrusion', {
      profile: [[0, 0], [1, 0], [1, 1]],
      depth: NaN,
    });
    const json = makeEnvelope({ entities: { ex2: entity }, order: ['ex2'] });
    expect(() => deserializeDocument(json)).toThrow(/depth/i);
  });

  it('throws on extrusion entity with Infinity depth', () => {
    const entity = validEntityBase('ex3', 'extrusion', {
      profile: [[0, 0], [1, 0], [1, 1]],
      depth: Infinity,
    });
    const json = makeEnvelope({ entities: { ex3: entity }, order: ['ex3'] });
    expect(() => deserializeDocument(json)).toThrow(/depth/i);
  });

  // ── rectangle validation ──────────────────────────────────────────────────

  it('throws on rectangle entity with width = 0', () => {
    const entity = validEntityBase('r1', 'rectangle', { width: 0, height: 5 });
    const json = makeEnvelope({ entities: { r1: entity }, order: ['r1'] });
    expect(() => deserializeDocument(json)).toThrow(/width/i);
  });

  it('throws on rectangle entity with height <= 0', () => {
    const entity = validEntityBase('r2', 'rectangle', { width: 5, height: -2 });
    const json = makeEnvelope({ entities: { r2: entity }, order: ['r2'] });
    expect(() => deserializeDocument(json)).toThrow(/height/i);
  });

  // ── arc / circle radius validation ────────────────────────────────────────

  it('throws on arc entity with radius = 0', () => {
    const entity = validEntityBase('arc1', 'arc', {
      center: [0, 0],
      radius: 0,
      startAngle: 0,
      endAngle: Math.PI,
    });
    const json = makeEnvelope({ entities: { arc1: entity }, order: ['arc1'] });
    expect(() => deserializeDocument(json)).toThrow(/radius/i);
  });

  it('throws on circle entity with negative radius', () => {
    const entity = validEntityBase('ci1', 'circle', { center: [0, 0], radius: -3 });
    const json = makeEnvelope({ entities: { ci1: entity }, order: ['ci1'] });
    expect(() => deserializeDocument(json)).toThrow(/radius/i);
  });

  // ── ellipse validation ────────────────────────────────────────────────────

  it('throws on ellipse entity with radiusX = 0', () => {
    const entity = validEntityBase('el1', 'ellipse', { center: [0, 0], radiusX: 0, radiusY: 3 });
    const json = makeEnvelope({ entities: { el1: entity }, order: ['el1'] });
    expect(() => deserializeDocument(json)).toThrow(/radiusX/i);
  });

  it('throws on ellipse entity with radiusY <= 0', () => {
    const entity = validEntityBase('el2', 'ellipse', { center: [0, 0], radiusX: 3, radiusY: -1 });
    const json = makeEnvelope({ entities: { el2: entity }, order: ['el2'] });
    expect(() => deserializeDocument(json)).toThrow(/radiusY/i);
  });

  // ── dangling layerId reference (lines 302-303) ────────────────────────────

  it('throws when entity layerId does not reference a known layer', () => {
    const entity = validEntityBase('e1', 'line', { layerId: 'layer-ghost' });
    // Note: entity has layerId 'layer-ghost' but we only define 'layer-default' in layers
    const json = makeEnvelope({ entities: { e1: entity }, order: ['e1'] });
    expect(() => deserializeDocument(json)).toThrow(/layerId.*layer-ghost/i);
  });

  it('load_document surfaces dangling layerId as a graceful no-op', () => {
    const entity = validEntityBase('e1', 'line', { layerId: 'layer-missing' });
    const json = makeEnvelope({ entities: { e1: entity }, order: ['e1'] });
    const doc = createEmptyDocument();
    const result = execute(doc, 'load_document', { json });
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toMatch(/layer-missing/i);
  });
});

// ---------------------------------------------------------------------------
// KI6 — Material validation branches
// ---------------------------------------------------------------------------

describe('deserializeDocument — material validation', () => {
  beforeEach(() => __resetIdCounter());

  it('accepts a valid material and round-trips it', () => {
    const json = makeEnvelope({
      materials: {
        steel: { density: 7850, color: '#808080', metalness: 0.8, roughness: 0.2 },
      },
    });
    const restored = deserializeDocument(json);
    const mats = (restored as unknown as Record<string, unknown>)['materials'] as Record<string, unknown>;
    expect(mats['steel']).toBeDefined();
  });

  it('throws when a material is not an object (non-object value)', () => {
    const json = makeEnvelope({ materials: { bad: 'not-an-object' } });
    expect(() => deserializeDocument(json)).toThrow(/material/i);
  });

  it('throws when material density <= 0', () => {
    const json = makeEnvelope({
      materials: {
        bad: { density: 0, color: '#aabbcc', metalness: 0.5, roughness: 0.5 },
      },
    });
    expect(() => deserializeDocument(json)).toThrow(/density/i);
  });

  it('throws when material density is negative', () => {
    const json = makeEnvelope({
      materials: {
        bad: { density: -100, color: '#aabbcc', metalness: 0.5, roughness: 0.5 },
      },
    });
    expect(() => deserializeDocument(json)).toThrow(/density/i);
  });

  it('throws when material color is not a valid hex (#rrggbb)', () => {
    const json = makeEnvelope({
      materials: {
        bad: { density: 1000, color: 'silver', metalness: 0.5, roughness: 0.5 },
      },
    });
    expect(() => deserializeDocument(json)).toThrow(/hex color/i);
  });

  it('throws when material metalness is out of [0, 1] (> 1)', () => {
    const json = makeEnvelope({
      materials: {
        bad: { density: 1000, color: '#aabbcc', metalness: 1.5, roughness: 0.5 },
      },
    });
    expect(() => deserializeDocument(json)).toThrow(/metalness/i);
  });

  it('throws when material metalness is out of [0, 1] (< 0)', () => {
    const json = makeEnvelope({
      materials: {
        bad: { density: 1000, color: '#aabbcc', metalness: -0.1, roughness: 0.5 },
      },
    });
    expect(() => deserializeDocument(json)).toThrow(/metalness/i);
  });

  it('throws when material roughness is out of [0, 1] (> 1)', () => {
    const json = makeEnvelope({
      materials: {
        bad: { density: 1000, color: '#aabbcc', metalness: 0.5, roughness: 2.0 },
      },
    });
    expect(() => deserializeDocument(json)).toThrow(/roughness/i);
  });

  it('throws when material roughness is out of [0, 1] (< 0)', () => {
    const json = makeEnvelope({
      materials: {
        bad: { density: 1000, color: '#aabbcc', metalness: 0.5, roughness: -0.5 },
      },
    });
    expect(() => deserializeDocument(json)).toThrow(/roughness/i);
  });

  it('throws when material metalness is NaN', () => {
    const json = makeEnvelope({
      materials: {
        bad: { density: 1000, color: '#aabbcc', metalness: NaN, roughness: 0.5 },
      },
    });
    expect(() => deserializeDocument(json)).toThrow(/metalness/i);
  });
});

// ---------------------------------------------------------------------------
// KI6 — Parameter validation branches
// ---------------------------------------------------------------------------

describe('deserializeDocument — parameter validation', () => {
  beforeEach(() => __resetIdCounter());

  it('throws when a parameter entry is not an object', () => {
    const json = makeEnvelope({ parameters: { bad: 'not-an-object' } });
    expect(() => deserializeDocument(json)).toThrow(/parameter/i);
  });

  it('throws when parameter name field is not a string', () => {
    const json = makeEnvelope({
      parameters: {
        width: { name: 42, expression: '10', value: 10 },
      },
    });
    expect(() => deserializeDocument(json)).toThrow(/name field/i);
  });

  it('throws when parameter expression field is not a string', () => {
    const json = makeEnvelope({
      parameters: {
        width: { name: 'width', expression: 10, value: 10 },
      },
    });
    expect(() => deserializeDocument(json)).toThrow(/expression/i);
  });

  it('throws when parameter value field is not a number', () => {
    const json = makeEnvelope({
      parameters: {
        width: { name: 'width', expression: '10', value: 'ten' },
      },
    });
    expect(() => deserializeDocument(json)).toThrow(/value must be a number/i);
  });

  it('accepts a valid parameter and round-trips it', () => {
    const json = makeEnvelope({
      parameters: {
        width: { name: 'width', expression: '42', value: 42 },
      },
    });
    const restored = deserializeDocument(json);
    const params = (restored as unknown as Record<string, unknown>)['parameters'] as Record<string, unknown>;
    expect(params['width']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// KI6 — Migration: older documents missing optional fields get correct defaults
// ---------------------------------------------------------------------------

describe('deserializeDocument — migration / back-compat defaults', () => {
  beforeEach(() => __resetIdCounter());

  it('fills parameters: {} when the field is absent', () => {
    const json = makeEnvelope();  // makeEnvelope does not include parameters
    const restored = deserializeDocument(json);
    expect((restored as unknown as Record<string, unknown>)['parameters']).toEqual({});
  });

  it('fills featureHistory: [] when the field is absent', () => {
    const json = makeEnvelope();
    const restored = deserializeDocument(json);
    const fh = (restored as unknown as Record<string, unknown>)['featureHistory'];
    expect(Array.isArray(fh)).toBe(true);
    expect(fh).toHaveLength(0);
  });

  it('fills animations: {} when the field is absent', () => {
    const json = makeEnvelope();
    const restored = deserializeDocument(json);
    expect((restored as unknown as Record<string, unknown>)['animations']).toEqual({});
  });

  it('fills configurations: {} when the field is absent', () => {
    const json = makeEnvelope();
    const restored = deserializeDocument(json);
    expect((restored as unknown as Record<string, unknown>)['configurations']).toEqual({});
  });

  it('fills materials: {} when the field is absent', () => {
    const json = makeEnvelope();
    const restored = deserializeDocument(json);
    expect((restored as unknown as Record<string, unknown>)['materials']).toEqual({});
  });

  it('fills groups: {} when the field is absent', () => {
    const json = makeEnvelope();
    const restored = deserializeDocument(json);
    expect((restored as unknown as Record<string, unknown>)['groups']).toEqual({});
  });

  it('fills units: "mm" when the field is absent', () => {
    const json = makeEnvelope();
    const restored = deserializeDocument(json);
    expect((restored as unknown as Record<string, unknown>)['units']).toBe('mm');
  });

  it('fills units: "mm" when the value is an unrecognised string', () => {
    const json = makeEnvelope({ units: 'parsec' });
    const restored = deserializeDocument(json);
    expect((restored as unknown as Record<string, unknown>)['units']).toBe('mm');
  });

  it('preserves valid units when present', () => {
    const json = makeEnvelope({ units: 'cm' });
    const restored = deserializeDocument(json);
    expect((restored as unknown as Record<string, unknown>)['units']).toBe('cm');
  });

  it('fills displayPrecision: 3 when the field is absent', () => {
    const json = makeEnvelope();
    const restored = deserializeDocument(json);
    expect((restored as unknown as Record<string, unknown>)['displayPrecision']).toBe(3);
  });

  it('preserves displayPrecision when it is a valid non-negative integer', () => {
    const json = makeEnvelope({ displayPrecision: 6 });
    const restored = deserializeDocument(json);
    expect((restored as unknown as Record<string, unknown>)['displayPrecision']).toBe(6);
  });

  it('falls back to displayPrecision 3 when a float is supplied (not an integer)', () => {
    const json = makeEnvelope({ displayPrecision: 1.5 });
    const restored = deserializeDocument(json);
    expect((restored as unknown as Record<string, unknown>)['displayPrecision']).toBe(3);
  });

  it('falls back to displayPrecision 3 when a negative value is supplied', () => {
    const json = makeEnvelope({ displayPrecision: -2 });
    const restored = deserializeDocument(json);
    expect((restored as unknown as Record<string, unknown>)['displayPrecision']).toBe(3);
  });

  it('a current-version document round-trips fully unchanged (serialize → deserialize identity)', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 2, 3] }).document;
    doc = execute(doc, 'draw_circle', { center: [1, 1], radius: 2 }).document;
    const json = serializeDocument(doc);
    const restored = deserializeDocument(json);
    expect(restored).toEqual(doc);
  });
});

// ---------------------------------------------------------------------------
// KI6 — add_box guard branches: NaN / Infinity / unresolved-expression-string
// ---------------------------------------------------------------------------

describe('add_box — dimension guard branches', () => {
  beforeEach(() => __resetIdCounter());

  it('NaN width is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_box', { size: [NaN, 1, 1] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('size');
  });

  it('Infinity height is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_box', { size: [1, Infinity, 1] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('negative depth is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_box', { size: [1, 1, -1] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('size');
  });
});

// ---------------------------------------------------------------------------
// KI6 — geometry.ts line 599: delete_entity on doc where groups is undefined
// ---------------------------------------------------------------------------

describe('delete_entity — doc.groups null-safety', () => {
  beforeEach(() => __resetIdCounter());

  it('deletes an entity safely when doc.groups is undefined', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const id = created.affected[0]!;

    // Manually strip groups to simulate an older/thin document.
    const docWithoutGroups = { ...doc } as Partial<CadDocument> & Omit<CadDocument, 'groups'>;
    delete (docWithoutGroups as Record<string, unknown>)['groups'];

    const result = execute(docWithoutGroups as CadDocument, 'delete_entity', { id });
    expect(result.document.entities[id]).toBeUndefined();
    expect(result.document.order).not.toContain(id);
    expect(result.affected).toEqual([id]);
  });
});
