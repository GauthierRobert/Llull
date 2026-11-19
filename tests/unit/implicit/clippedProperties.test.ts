/**
 * 14 FLL-M1b: implicit_properties of a body created with explicit bounds measures the bounds-clipped solid (the FE solid of fea_mesh source
 * implicit_field, FLL-D8), not its open display mesh; the transient clip-node ids carry a character the id minter never emits.
 */
import { describe, expect, it } from 'vitest';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import { counterIdSource, idPrefixOf, stepIdSource } from '@lib/id';
import { implicitBodyField } from '@implicit/index';
import { RESERVED_ID_MARK } from '@implicit/nodeValidation';
import { implicitDocument } from '@implicit/document';
import { implicitOf } from '@implicit/model';
import type { CadDocument, Vec3 } from '@core/model/types';
import { expectPure } from '../../helpers/expectNoOp';
import { empty, ok, run } from './helpers';

const BOUNDS: { min: Vec3; max: Vec3 } = { min: [-4, -3, -2], max: [4, 3, 2] };

function clippedGyroid(): { doc: CadDocument; bodyId: string; fieldId: string } {
  const lattice = ok(empty(), 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 0.6, normalize: 'none', cellSize: 5 });
  const body = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.5, bounds: BOUNDS });
  return { doc: body.doc, bodyId: body.id, fieldId: lattice.id };
}

describe('implicit_properties on an explicit-bounds body', () => {
  it('measures field ∩ bounds box by quadrature (the FE solid), labelled; the open display mesh is not read', () => {
    const { doc, bodyId, fieldId } = clippedGyroid();
    const measured = ok(doc, 'implicit_properties', { id: bodyId, voxel: 0.1 });
    const data = measured.data;
    expect(data['measured']).toBe('bounds-clipped solid');
    expect(data['field']).toBe(fieldId);
    expect(data['area']).toBeNull();
    expect(data['volumeMesh']).toBeNull();
    expect(data['bounds']).toEqual(BOUNDS);
    expect(measured.result.summary).toContain('(bounds-clipped solid)');
    const found = implicitBodyField(doc, bodyId);
    if (!found.ok) throw new Error(found.message);
    const fe = tsFieldEngine.measure(found.program, { ...BOUNDS, voxel: 0.1 }, null, { kind: 'volume', sampling: 'midpoint' });
    if (!fe.ok || fe.kind !== 'volume') throw new Error('no volume');
    expect(Math.abs(Number(data['volume']) / fe.volume - 1)).toBeLessThan(1e-9);
    // the same solid as the field measured in a box region equal to the bounds
    const region = ok(doc, 'add_field_primitive', { shape: 'box', size: [8, 6, 4] });
    const inRegion = ok(region.doc, 'implicit_properties', { id: fieldId, region: region.id, voxel: 0.1 });
    expect(Math.abs(Number(data['volume']) / Number(inRegion.data['volume']) - 1)).toBeLessThan(1e-9);
    expect(inRegion.data['measured']).toBe('field');
  });

  it('a body without explicit bounds is still measured on its mesh', () => {
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 3 });
    const body = ok(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5 });
    const measured = ok(body.doc, 'implicit_properties', { id: body.id });
    expect(measured.data['measured']).toBe('body mesh');
    expect(measured.data['volume']).toBe(measured.data['volumeMesh']);
    expect(Number(measured.data['area'])).toBeGreaterThan(0);
    expect(measured.result.summary).not.toContain('bounds-clipped');
  });

  it('is pure', () => {
    const { doc, bodyId } = clippedGyroid();
    expectPure(doc, () => run(doc, 'implicit_properties', { id: bodyId, voxel: 0.25 }));
  });
});

describe('clip-node ids cannot collide with document nodes', () => {
  it('the id minter never emits the reserved character, whatever the prefix and step', () => {
    const prefixes = ['fld', 'fll', 'fll-clip', 'imp', 'e'];
    for (const prefix of prefixes) {
      const step = stepIdSource('12');
      for (let k = 0; k < 50; k += 1) {
        expect(step.next(prefix)).not.toContain(RESERVED_ID_MARK);
        expect(counterIdSource.next(prefix)).not.toContain(RESERVED_ID_MARK);
      }
    }
    expect(stepIdSource('3').next('fll')).toMatch(/^fll-3\.1$/);
    expect(idPrefixOf('fld-4.2', 'x')).toBe('fld');
  });

  it('a stored field node whose id carries the reserved character is refused on load; an old fll-clip id still loads', () => {
    const { doc, fieldId } = clippedGyroid();
    const raw = (JSON.parse(serializeDocument(doc)) as { document: Record<string, unknown> }).document;
    expect(implicitDocument.validate(raw)).toEqual([]);
    const implicit = raw['implicit'] as { fields: Record<string, Record<string, unknown>> };
    const node = implicit.fields[fieldId] ?? {};
    const withNode = (id: string): Record<string, unknown> => ({
      ...raw,
      implicit: { ...implicit, fields: { ...implicit.fields, [id]: { ...node, id } } },
    });
    expect(implicitDocument.validate(withNode(`${RESERVED_ID_MARK}fll-clip`))).toEqual([
      expect.stringContaining(`field '${RESERVED_ID_MARK}fll-clip' uses the reserved character`),
    ]);
    expect(implicitDocument.validate(withNode('fll-clip'))).toEqual([]);
  });

  it('a body whose own field carries the old clip id is clipped correctly (the old ids let the clip box replace it)', () => {
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
    const body = ok(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5, bounds: BOUNDS });
    const model = implicitOf(body.doc);
    const record = model.bodies[body.id];
    const node = model.fields[sphere.id];
    if (record === undefined || node === undefined) throw new Error('no body');
    const renamed: CadDocument = {
      ...body.doc,
      implicit: {
        ...model,
        fields: { 'fll-clip-box': { ...node, id: 'fll-clip-box' } },
        bodies: { ...model.bodies, [body.id]: { ...record, field: 'fll-clip-box' } },
      },
    };
    const found = implicitBodyField(renamed, body.id);
    if (!found.ok) throw new Error(found.message);
    // (3.5, 2.5, 1.5) is inside the bounds box but outside the sphere: outside the clipped solid; the centre is inside
    const values = Array.from(tsFieldEngine.evaluate(found.program, Float64Array.from([3.5, 2.5, 1.5, 0, 0, 0]), false).values);
    expect(values[0]).toBeGreaterThan(0);
    expect(values[1]).toBeLessThan(0);
  });
});
