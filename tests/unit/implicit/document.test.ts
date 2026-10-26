/** Document extension and guard of the implicit plugin: validation of every node op, restore edge cases, guard on records. */
import { describe, expect, it } from 'vitest';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { implicitDocument, implicitGuard } from '@implicit/document';
import { type CadDocument } from '@core/model/types';
import { empty, ok, run } from './helpers';

const slice = (fields: Record<string, unknown>, bodies: Record<string, unknown> = {}): Record<string, unknown> => ({
  implicit: { version: 1, fields, bodies },
});
const errorsOf = (raw: Record<string, unknown>): string[] => implicitDocument.validate(raw);

const v = [0, 0, 0];

describe('validate', () => {
  it('accepts an absent slice and every well-formed node op', () => {
    expect(errorsOf({})).toEqual([]);
    const fields = {
      a: { id: 'a', op: 'primitive', shape: 'sphere', dims: { radius: 1 }, position: v, rotation: v },
      b: { id: 'b', op: 'solid', entityId: 'x' },
      c: { id: 'c', op: 'boolean', operands: ['a', 'b'] },
      d: { id: 'd', op: 'offset', source: 'a', distance: 1 },
      e: { id: 'e', op: 'shell', source: 'a', thickness: 1 },
      f: { id: 'f', op: 'transform', source: 'a', position: v, rotation: v, scale: 1 },
      g: { id: 'g', op: 'tpms', kind: 'gyroid', cellSize: v, origin: v, rotation: v, form: 'sheet', normalize: 'none', control: {} },
      h: { id: 'h', op: 'struts', cell: 'cubic', cellSize: v, origin: v, rotation: v, radius: 1 },
    };
    expect(errorsOf(slice(fields))).toEqual([]);
  });

  it.each([
    ['primitive', { shape: 'sphere', dims: 1, position: v, rotation: v }],
    ['primitive', { shape: [], dims: {}, position: v, rotation: v }],
    ['primitive', { shape: 'box', dims: { size: [1, 1, Number.POSITIVE_INFINITY] }, position: v, rotation: v }],
    ['solid', { entityId: 1 }],
    ['boolean', { operands: [1] }],
    ['offset', { source: 'a', distance: true }],
    ['shell', { source: 1, thickness: 1 }],
    ['transform', { source: 'a', position: v, rotation: v, scale: 'x' }],
    ['tpms', { kind: 'gyroid', cellSize: v, origin: v, rotation: v, form: 'sheet', normalize: 'none', control: 1 }],
    ['tpms', { cellSize: v, origin: v, control: {} }],
    ['struts', { cell: 'cubic', cellSize: [1], origin: v, rotation: v, radius: 1 }],
    ['struts', { cellSize: v, origin: v, radius: 1 }],
  ])('rejects a %s node with malformed parameters', (op, extra) => {
    expect(errorsOf(slice({ n: { id: 'n', op, ...extra } })).join()).toContain('malformed parameters');
  });

  it('rejects nodes with another id, an unknown op, a non-record and malformed slices and bodies', () => {
    expect(errorsOf(slice({ n: { id: 'other', op: 'solid', entityId: 'x' } })).join()).toContain('not a valid node');
    expect(errorsOf(slice({ n: { id: 'n', op: 'nope' } })).join()).toContain('not a valid node');
    expect(errorsOf(slice({ n: 3 })).join()).toContain('not a valid node');
    expect(errorsOf({ implicit: 3 }).join()).toContain('malformed slice');
    expect(errorsOf({ implicit: { version: 1, fields: {} } }).join()).toContain('malformed slice');
    const body = {
      id: 'b',
      field: 'a',
      voxel: 1,
      bounds: { min: v, max: v },
      contentHash: 'h',
      name: 'n',
      engine: 'ts',
      mesher: 'tetra',
      color: '#fff',
    };
    expect(errorsOf(slice({}, { b: body }))).toEqual([]);
    for (const broken of [
      { voxel: 0 },
      { bounds: 1 },
      { bounds: { min: v, max: 1 } },
      { contentHash: 1 },
      { name: 1 },
      { engine: 1 },
      { mesher: 'marching_cubes' },
      { color: 1 },
      { field: 1 },
      { id: 'x' },
    ])
      expect(errorsOf(slice({}, { b: { ...body, ...broken } })).join()).toContain("body 'b' is malformed");
    expect(errorsOf(slice({}, { b: 4 })).join()).toContain("body 'b' is malformed");
  });
});

describe('restore', () => {
  const docWithBody = (): { doc: CadDocument; id: string } => {
    const s = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
    const b = ok(s.doc, 'create_implicit_body', { field: s.id, voxel: 0.5 });
    return { doc: b.doc, id: b.id };
  };
  const rawOf = (doc: CadDocument): Record<string, unknown> =>
    (JSON.parse(serializeDocument(doc)) as { document: Record<string, unknown> }).document;

  it('returns the raw document unchanged without a slice, with an invalid slice or when nothing is missing', () => {
    const raw = rawOf(empty());
    expect(implicitDocument.restore(raw)).toBe(raw);
    const bad = { ...raw, implicit: 3 };
    expect(implicitDocument.restore(bad)).toBe(bad);
    const { doc } = docWithBody();
    const complete = JSON.parse(serializeDocument(doc, { includeDerived: true })).document as Record<string, unknown>;
    expect(implicitDocument.restore(complete)).toBe(complete);
  });

  it('drops a body the engine cannot realise (missing field) and reports it after load; non-array order is tolerated', () => {
    const { doc, id } = docWithBody();
    const raw = rawOf(doc) as { implicit: { bodies: Record<string, { field: string }> }; order: unknown; selection: unknown };
    const body = raw.implicit.bodies[id];
    if (body === undefined) throw new Error('body expected');
    body.field = 'missing';
    const restored = implicitDocument.restore({ ...raw, units: 3, selection: 'none' }) as {
      entities: Record<string, unknown>;
      order: string[];
      selection: unknown;
    };
    expect(restored.entities[id]).toBeUndefined();
    expect(restored.order).not.toContain(id);
    expect(restored.selection).toBe('none');
    const stale = { ...doc, entities: {} } as CadDocument;
    expect(implicitDocument.afterLoad?.(stale)?.[0]).toContain('IMP_BODY_STALE');
    expect(implicitDocument.afterLoad?.(doc)).toEqual([]);
  });
});

describe('guard', () => {
  it('refuses a body entity that outlives its record and ignores bodies without an entity', () => {
    const s = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
    const b = ok(s.doc, 'create_implicit_body', { field: s.id, voxel: 0.5 });
    const recordGone: CadDocument = { ...b.doc, implicit: { version: 1, fields: b.doc.implicit?.fields ?? {}, bodies: {} } };
    expect(implicitGuard.check(b.doc, recordGone, 'x')).toMatchObject({ error: { code: 'IMP_DERIVED_READ_ONLY' } });
    const entityGone: CadDocument = {
      ...recordGone,
      entities: Object.fromEntries(Object.entries(b.doc.entities).filter(([key]) => key !== b.id)),
    };
    expect(implicitGuard.check(b.doc, entityGone, 'x')).toBeNull();
    expect(implicitGuard.check(entityGone, b.doc, 'x')).toBeNull();
  });

  it('survives a replay of a chained source (the source regenerates equal)', () => {
    const box = ok(empty(), 'add_box', { size: [3, 3, 3] });
    const f = ok(box.doc, 'field_from_solid', { entityId: box.id });
    const body = ok(f.doc, 'create_implicit_body', { field: f.id, voxel: 0.5 });
    expect(run(body.doc, 'replay_history', {}).result.error).toBeUndefined();
  });
});
