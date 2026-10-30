/** 05 IMP M6: dual-contoured bodies (VC-IMP-15 mesh gate) and the 3MF level-set export (FR-IMP-52). */
import { describe, expect, it } from 'vitest';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { implicitDocument } from '@implicit/document';
import { base64ToUint8Array } from '@lib/base64';
import { expectPure } from '../../helpers/expectNoOp';
import { unzip } from '../../helpers/unzipStore';
import { empty, expectRefused, ok, run } from './helpers';

const sc = (): ReturnType<typeof ok> => {
  const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [10, 10, 10], position: [5, 5, 5] });
  return ok(box.doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: 1, origin: [0, 0, 0], region: box.id });
};

describe('mesher dual_contouring', () => {
  it('meets the 0.5 % mesh gate of the simple-cubic cell that the tetrahedra miss (VC-IMP-15, VC-IMP-49)', () => {
    const lattice = sc();
    for (const voxel of [0.2, 0.1]) {
      const dc = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel, mesher: 'dual_contouring' });
      const tet = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel });
      const error = (step: { data: Record<string, unknown> }): number =>
        Math.abs((step.data['volumeMesh'] as number) - 82.93407) / 82.93407;
      expect(error(dc)).toBeLessThan(0.005);
      expect(error(dc)).toBeLessThan(error(tet) / 4);
      expect(dc.data['closedManifold']).toBe(true);
      expect(dc.data['mesher']).toBe('dual_contouring');
      expect(dc.data['mesherFallback']).toBe(false);
      expect(dc.data['dualContouringSplitCells']).toBe(0);
    }
  });

  it('records the mesher, keeps the hash apart from the tetrahedra, and re-derives the same mesh on load', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [8, 6, 4] });
    const dc = ok(box.doc, 'create_implicit_body', { field: box.id, voxel: 0.5, mesher: 'dual_contouring' });
    const tet = ok(box.doc, 'create_implicit_body', { field: box.id, voxel: 0.5 });
    expect(dc.doc.implicit?.bodies[dc.id]).toMatchObject({ mesher: 'dual_contouring' });
    expect(dc.doc.implicit?.bodies[dc.id]?.contentHash).not.toBe(tet.doc.implicit?.bodies[tet.id]?.contentHash);
    const raw = (JSON.parse(serializeDocument(dc.doc)) as { document: Record<string, unknown> }).document;
    const restored = implicitDocument.restore(raw) as { entities: Record<string, { mesh: { indices: number[] } }> };
    expect(restored.entities[dc.id]?.mesh.indices).toEqual(
      (dc.doc.entities[dc.id] as unknown as { mesh: { indices: number[] } }).mesh.indices,
    );
    expect(
      implicitDocument.validate?.({ ...raw, implicit: { ...(raw['implicit'] as object), bodies: { [dc.id]: { id: dc.id } } } }),
    ).not.toEqual([]);
  });

  it('is pure and refuses an unknown mesher', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [4, 4, 4] });
    expectPure(box.doc, () => run(box.doc, 'create_implicit_body', { field: box.id, voxel: 0.5, mesher: 'dual_contouring' }));
    expectRefused(box.doc, run(box.doc, 'create_implicit_body', { field: box.id, voxel: 0.5, mesher: 'nope' }), 'CMD_INVALID_PARAMS');
  });
});

describe('export_3mf implicit levelset', () => {
  const modelOf = (data: Record<string, unknown>): string => {
    const files = unzip(base64ToUint8Array(data['base64'] as string) ?? new Uint8Array());
    return new TextDecoder().decode(files.get('3D/3dmodel.model'));
  };

  it('writes the field as an implicit function with a level-set object and no triangles', () => {
    const a = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 4 });
    const b = ok(a.doc, 'add_field_primitive', { shape: 'box', size: [5, 5, 5], position: [3, 0, 0] });
    const u = ok(b.doc, 'combine_fields', { op: 'union', a: a.id, b: b.id, blend: { kind: 'quadratic', radius: 1 } });
    const body = ok(u.doc, 'create_implicit_body', { field: u.id, voxel: 0.5 });
    const out = ok(body.doc, 'export_3mf', { entityIds: [body.id], implicit: 'levelset' });
    const xml = modelOf(out.data);
    expect(xml).toContain('requiredextensions="v i"');
    expect(xml).toContain('<v:levelset');
    expect(xml).toContain('<i:implicitfunction');
    expect(xml).toContain('<i:decomposevector');
    expect(xml).not.toContain('<i:sqrt');
    expect(out.data['implicit']).toEqual({ written: [body.id], skipped: [] });
    expect(out.result.summary).toContain('level set');
  });

  it('keeps strut lattices as meshes with the reason, and writes plain meshes when implicit is mesh', () => {
    const lattice = sc();
    const body = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.5 });
    const out = ok(body.doc, 'export_3mf', { entityIds: [body.id], implicit: 'levelset' });
    expect((out.data['implicit'] as { skipped: Array<{ reason: string }> }).skipped[0]?.reason).toContain('beam lattice');
    expect(modelOf(out.data)).not.toContain('<v:levelset');
    const plain = ok(body.doc, 'export_3mf', { entityIds: [body.id], implicit: 'mesh' });
    expect(modelOf(plain.data)).not.toContain('<v:levelset');
  });

  it('writes a mesh_sdf operand as a mesh resource and every blend as native nodes; sqrt becomes pow', () => {
    const solid = ok(empty(), 'add_box', { size: [6, 6, 6] });
    const sf = ok(solid.doc, 'field_from_solid', { entityId: solid.id });
    const shell = ok(sf.doc, 'shell_field', { field: sf.id, thickness: 1 });
    const sphere = ok(shell.doc, 'add_field_primitive', { shape: 'sphere', radius: 3 });
    const exp = ok(sphere.doc, 'combine_fields', {
      op: 'subtract',
      a: shell.id,
      b: sphere.id,
      blend: { kind: 'exponential', radius: 0.5 },
    });
    const ch = ok(exp.doc, 'combine_fields', { op: 'union', a: shell.id, b: sphere.id, blend: { kind: 'chamfer', radius: 0.5 } });
    const e1 = ok(ch.doc, 'create_implicit_body', { field: exp.id, voxel: 0.5 });
    const e2 = ok(e1.doc, 'create_implicit_body', { field: ch.id, voxel: 0.5 });
    const xml = modelOf(ok(e2.doc, 'export_3mf', { entityIds: [e1.id, e2.id], implicit: 'levelset' }).data);
    expect(xml).toContain('<i:mesh ');
    expect(xml).toContain('<i:pow ');
    expect(xml).toContain('<i:exp ');
    expect(xml).toContain('<i:log ');
  });
});

describe('kernel_info field engine line', () => {
  it('names the engine and its limits', () => {
    const info = ok(empty(), 'kernel_info', {});
    const field = info.data['fieldEngine'] as { name: string; limits: { maxSamples: number } };
    expect(field.name).toBe('ts');
    expect(field.limits.maxSamples).toBeGreaterThan(0);
    expect(info.result.summary).toContain('field engine ts');
  });
});
