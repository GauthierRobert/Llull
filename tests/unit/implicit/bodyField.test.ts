/** implicitBodyField (14 FLL-M1): the field program and bounds of an implicit body for the host's field mesher, and its refusals. */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { implicitBodyField } from '@implicit/index';
import { bodyOf, implicitOf } from '@implicit/model';
import { empty, expectRefused, lowDiscrepancyPoints, ok, run } from './helpers';

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

describe('a body clipped by explicit bounds', () => {
  it('is the field intersected with the bounds box: an exact iso-surface, the same solid implicit_properties measures in that region', () => {
    const lattice = ok(empty(), 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 0.6, normalize: 'none', cellSize: 5 });
    const bounds = { min: [-4, -3, -2], max: [4, 3, 2] };
    const body = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.5, bounds });
    const found = implicitBodyField(body.doc, body.id);
    if (!found.ok) throw new Error(found.message);
    expect(found.bounds).toEqual(bounds);
    const unclipped = implicitBodyField({ ...body.doc }, body.id);
    expect(unclipped.ok).toBe(true);
    // sign of the clipped program = inside the sheet AND inside the box, at points spread over the box padded by 2
    const points = lowDiscrepancyPoints(4000, 6);
    const flat = Float64Array.from(points.flat());
    const clipped = tsFieldEngine.evaluate(found.program, flat, false).values;
    const model = implicitOf(body.doc);
    const sheet = model.fields[lattice.id];
    if (sheet === undefined) throw new Error('no field');
    const region = ok(body.doc, 'add_field_primitive', { shape: 'box', size: [8, 6, 4] });
    const free = ok(region.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.5, bounds: { min: [-6, -6, -6], max: [6, 6, 6] } });
    const field = implicitBodyField(free.doc, free.id);
    if (!field.ok) throw new Error(field.message);
    const raw = tsFieldEngine.evaluate(field.program, flat, false).values;
    let agree = 0;
    points.forEach((p, i) => {
      const inBox = Math.abs(p[0]) < 4 && Math.abs(p[1]) < 3 && Math.abs(p[2]) < 2;
      const expected = inBox && (raw[i] ?? 0) < 0;
      if ((clipped[i] ?? 0) < 0 === expected) agree += 1;
    });
    expect(agree).toBe(points.length);
    const measured = ok(region.doc, 'implicit_properties', { id: lattice.id, region: region.id, voxel: 0.1 });
    const clippedVolume = tsFieldEngine.measure(found.program, { min: [-4, -3, -2], max: [4, 3, 2], voxel: 0.1 }, null, {
      kind: 'volume',
      sampling: 'midpoint',
    });
    if (!clippedVolume.ok || clippedVolume.kind !== 'volume') throw new Error('no volume');
    expect(Math.abs(clippedVolume.volume / Number(measured.data['volume']) - 1)).toBeLessThan(1e-9);
  });
});

describe('implicit body material is read-only on the entity and checked on load', () => {
  it('refuses assign_material on the derived entity, unchanged', () => {
    const material = ok(empty(), 'create_material', { name: 'petg', density: 0.00127, color: '#88aacc', metalness: 0, roughness: 0.6 });
    const field = ok(material.doc, 'add_field_primitive', { shape: 'sphere', radius: 3 });
    const body = ok(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.5 });
    expectRefused(body.doc, run(body.doc, 'assign_material', { materialName: 'petg', entityIds: [body.id] }), 'IMP_DERIVED_READ_ONLY');
  });

  it('refuses to load a body whose material is not in the document, naming the path', () => {
    const material = ok(empty(), 'create_material', { name: 'petg', density: 0.00127, color: '#88aacc', metalness: 0, roughness: 0.6 });
    const field = ok(material.doc, 'add_field_primitive', { shape: 'sphere', radius: 3 });
    const body = ok(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.5, material: 'petg' });
    const saved = JSON.parse(serializeDocument(body.doc)) as {
      document: { implicit: { bodies: Record<string, Record<string, unknown>> } };
    };
    const record = saved.document.implicit.bodies[body.id];
    if (record === undefined) throw new Error('no saved body');
    record['materialId'] = 'ghost';
    const start = empty();
    const loaded = run(start, 'load_document', { json: JSON.stringify(saved) });
    expect(loaded.doc).toBe(start);
    expect(loaded.result.summary).toContain(`implicit.bodies.${body.id}.materialId: 'ghost' is not a material of the document`);
    const fine = empty();
    expect(run(fine, 'load_document', { json: serializeDocument(body.doc) }).doc).not.toBe(fine);
  });
});
