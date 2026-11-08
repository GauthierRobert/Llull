/** implicitBodyField (14 FLL-M1): the field program and bounds of an implicit body for the host's field mesher, and its refusals. */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { implicitBodyField } from '@implicit/index';
import { bodyOf, implicitOf } from '@implicit/model';
import { empty, expectRefused, ok, run } from './helpers';

function sphereBody(bounds?: { min: number[]; max: number[] }): { doc: CadDocument; bodyId: string; fieldId: string } {
  const field = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 4, position: [1, 2, 3] });
  const body = ok(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.5, ...(bounds === undefined ? {} : { bounds }) });
  return { doc: body.doc, bodyId: body.id, fieldId: field.id };
}

describe('implicitBodyField', () => {
  it('gives the compiled program and the support box the body was realised in', () => {
    const { doc, bodyId, fieldId } = sphereBody();
    const found = implicitBodyField(doc, bodyId);
    if (!found.ok) throw new Error(found.message);
    expect(found.field).toBe(fieldId);
    expect(found.bounds).toEqual({ min: [-3, -2, -1], max: [5, 6, 7] });
    const samples = tsFieldEngine.evaluate(found.program, Float64Array.from([1, 2, 3, 5, 2, 3]), false);
    expect(Array.from(samples.values)).toEqual([-4, 0]);
  });

  it('keeps explicit bounds', () => {
    const bounds = { min: [-4, -3, -2], max: [1, 2, 3] };
    const { doc, bodyId } = sphereBody(bounds);
    const found = implicitBodyField(doc, bodyId);
    expect(found).toMatchObject({ ok: true, bounds });
  });

  it('refuses an entity that is not an implicit body, a moved body and a body older than its field', () => {
    const { doc, bodyId } = sphereBody();
    expect(implicitBodyField(doc, 'nope')).toMatchObject({ ok: false, code: 'FLL_IMPLICIT_FIELD_MISSING' });
    const box = ok(doc, 'add_box', { size: [1, 1, 1] });
    expect(implicitBodyField(box.doc, box.id)).toMatchObject({ ok: false, code: 'FLL_IMPLICIT_FIELD_MISSING' });
    const entity = doc.entities[bodyId];
    if (entity === undefined) throw new Error('no body entity');
    const moved = { ...doc, entities: { ...doc.entities, [bodyId]: { ...entity, position: [1, 0, 0] as const } } };
    expect(implicitBodyField(moved, bodyId)).toMatchObject({ ok: false, code: 'FLL_IMPLICIT_FIELD_MISSING' });
    const model = implicitOf(doc);
    const body = bodyOf(doc, bodyId);
    if (body === undefined) throw new Error('no body record');
    const older = { ...doc, implicit: { ...model, bodies: { ...model.bodies, [bodyId]: { ...body, contentHash: 'old' } } } };
    const stale = implicitBodyField(older, bodyId);
    expect(stale).toMatchObject({ ok: false, code: 'IMP_BODY_STALE' });
    expect(stale.ok === false && stale.message).toContain('regenerate_implicit_bodies');
    const broken = { ...doc, implicit: { ...model, bodies: { ...model.bodies, [bodyId]: { ...body, field: 'fld-missing' } } } };
    expect(implicitBodyField(broken, bodyId)).toMatchObject({ ok: false, code: 'IMP_BODY_STALE' });
  });
});

describe('create_implicit_body material', () => {
  const withMaterial = (): CadDocument =>
    ok(empty(), 'create_material', { name: 'petg', density: 0.00127, color: '#88aacc', metalness: 0, roughness: 0.6 }).doc;

  it('keeps the material on the body record and on its entity, across save / load and regeneration', () => {
    const field = ok(withMaterial(), 'add_field_primitive', { shape: 'sphere', radius: 3 });
    const body = ok(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.5, material: 'petg' });
    expect(body.result.affected).toEqual([body.id]);
    expect(body.doc.entities[body.id]).toMatchObject({ kind: 'mesh', materialId: 'petg' });
    expect(bodyOf(body.doc, body.id)?.materialId).toBe('petg');
    const loaded = deserializeDocument(serializeDocument(body.doc));
    expect(loaded.entities[body.id]).toMatchObject({ kind: 'mesh', materialId: 'petg' });
    const regenerated = ok(body.doc, 'regenerate_implicit_bodies', { ids: [body.id] });
    expect(regenerated.doc.entities[body.id]?.materialId).toBe('petg');
    const plain = ok(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.5 });
    expect('materialId' in (plain.doc.entities[plain.id] ?? {})).toBe(false);
  });

  it('refuses a material the document does not hold', () => {
    const field = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 3 });
    expectRefused(
      field.doc,
      run(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.5, material: 'petg' }),
      'IMP_MATERIAL_NOT_FOUND',
    );
  });

  it('a body whose field lost its support box is stale', () => {
    const { doc, bodyId } = sphereBody();
    const plane = ok(doc, 'add_field_primitive', { shape: 'plane', normal: [0, 0, 1] });
    const model = implicitOf(plane.doc);
    const body = bodyOf(plane.doc, bodyId);
    if (body === undefined) throw new Error('no body record');
    const unbounded = { ...plane.doc, implicit: { ...model, bodies: { ...model.bodies, [bodyId]: { ...body, field: plane.id } } } };
    const found = implicitBodyField(unbounded, bodyId);
    expect(found).toMatchObject({ ok: false, code: 'IMP_BODY_STALE' });
    expect(found.ok === false && found.message).toContain('unbounded');
  });
});
