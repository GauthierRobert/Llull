/** edit_field, delete_field, regenerate_implicit_bodies (05 IMP M5, FR-IMP-01, L8): editing re-derives bodies, deleting needs a cascade, regeneration is idempotent; mesh asset store (D3). */
import { afterEach, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { setFieldEngine } from '@core/geometry/field/engine';
import type { FieldEngine } from '@core/geometry/field/engineTypes';
import type { FieldNode } from '@implicit/model';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import { type MeshAssetPort, setMeshAssetPort } from '@core/geometry/mesh/assets';
import type { MeshAssetRef } from '@core/model/meshProvenance';
import type { CadDocument, MeshData, MeshSolidEntity } from '@core/model/types';
import { implicitDocument } from '@implicit/document';
import { expectPure } from '../../helpers/expectNoOp';
import { empty, expectRefused, ok, run } from './helpers';

afterEach(() => {
  setFieldEngine(null);
  setMeshAssetPort(null);
});

const ball = (radius = 4, voxel = 0.5): { doc: CadDocument; field: string; body: string } => {
  const field = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius });
  const body = ok(field.doc, 'create_implicit_body', { field: field.id, voxel });
  return { doc: body.doc, field: field.id, body: body.id };
};

const volumeOf = (doc: CadDocument, body: string): number => ok(doc, 'implicit_properties', { id: body }).data['volumeMesh'] as number;

describe('edit_field', () => {
  it('changes a primitive and re-derives the body built on it (same ids, new mesh, new hash)', () => {
    const { doc, field, body } = ball(4);
    const before = doc.implicit?.bodies[body];
    const edited = ok(doc, 'edit_field', { id: field, changes: { radius: 6 } });
    expect(edited.result.affected).toEqual([field, body]);
    expect(edited.doc.implicit?.fields[field]).toMatchObject({ op: 'primitive', dims: { radius: 6 } });
    expect(edited.doc.implicit?.bodies[body]?.contentHash).not.toBe(before?.contentHash);
    expect(edited.data['rederivedBodies']).toEqual([body]);
    const exact = (4 / 3) * Math.PI * 216;
    expect(Math.abs(volumeOf(edited.doc, body) - exact) / exact).toBeLessThan(0.01);
    expect(edited.doc.order.filter((id) => id === body)).toHaveLength(1);
    const back = ok(edited.doc, 'edit_field', { id: field, changes: { radius: 4 } });
    expect(back.doc.implicit?.bodies[body]?.contentHash).toBe(before?.contentHash);
  });

  it('re-derives only the bodies that depend on the edited node', () => {
    const a = ball(3);
    const second = ok(a.doc, 'add_field_primitive', { shape: 'box', size: [4, 4, 4] });
    const other = ok(second.doc, 'create_implicit_body', { field: second.id, voxel: 0.5 });
    const edited = ok(other.doc, 'edit_field', { id: second.id, changes: { size: [6, 6, 6] } });
    expect(edited.data['rederivedBodies']).toEqual([other.id]);
    expect(edited.doc.entities[a.body]).toBe(other.doc.entities[a.body]);
  });

  it('reports a node nothing depends on without touching any body, and supports renaming and removing optional values with null', () => {
    const a = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 3 });
    const b = ok(a.doc, 'add_field_primitive', { shape: 'sphere', radius: 3, position: [4, 0, 0] });
    const blend = ok(b.doc, 'combine_fields', { op: 'union', a: a.id, b: b.id, blend: { kind: 'quadratic', radius: 1 } });
    const edited = ok(blend.doc, 'edit_field', { id: blend.id, changes: { blend: null, name: 'sharp' } });
    expect(edited.data['rederivedBodies']).toEqual([]);
    expect(edited.doc.implicit?.fields[blend.id]).toMatchObject({ op: 'boolean', kind: 'union', operands: [a.id, b.id], name: 'sharp' });
    expect(edited.doc.implicit?.fields[blend.id]).not.toHaveProperty('blend');
    const sub = ok(edited.doc, 'edit_field', { id: blend.id, changes: { op: 'subtract' } });
    expect(sub.doc.implicit?.fields[blend.id]).toMatchObject({ kind: 'subtract' });
  });

  it('edits lattices (a cell size change with a density target re-solves the control), offsets, shells, transforms and scalars', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [20, 20, 20], position: [10, 10, 10] });
    const lattice = ok(box.doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', relativeDensity: 0.3, cellSize: 10, region: box.id });
    const original = lattice.doc.implicit?.fields[lattice.id];
    const resized = ok(lattice.doc, 'edit_field', { id: lattice.id, changes: { cellSize: 5 } });
    const node = resized.doc.implicit?.fields[lattice.id];
    expect(node).toMatchObject({ op: 'tpms', cellSize: [5, 5, 5], relativeDensityTarget: 0.3 });
    expect(
      node?.op === 'tpms' && original?.op === 'tpms' ? (node.control.value as number) / (original.control.value as number) : 0,
    ).toBeCloseTo(0.5, 2);
    const thickness = ok(resized.doc, 'edit_field', { id: lattice.id, changes: { thickness: 0.8 } });
    expect(thickness.doc.implicit?.fields[lattice.id]).toMatchObject({ control: { kind: 'thickness', value: 0.8 } });
    expect(thickness.doc.implicit?.fields[lattice.id]).not.toHaveProperty('relativeDensityTarget');
    const struts = ok(box.doc, 'add_strut_lattice', { cell: 'octet', cellSize: 10, radius: 0.5, region: box.id });
    const strutEdit = ok(struts.doc, 'edit_field', { id: struts.id, changes: { radius: 0.7, region: null } });
    expect(strutEdit.doc.implicit?.fields[struts.id]).toMatchObject({ radius: 0.7 });
    expect(strutEdit.doc.implicit?.fields[struts.id]).not.toHaveProperty('region');
    const offset = ok(box.doc, 'offset_field', { field: box.id, distance: 1 });
    expect(ok(offset.doc, 'edit_field', { id: offset.id, changes: { distance: -1 } }).doc.implicit?.fields[offset.id]).toMatchObject({
      distance: -1,
    });
    const shell = ok(box.doc, 'shell_field', { field: box.id, thickness: 1 });
    expect(
      ok(shell.doc, 'edit_field', { id: shell.id, changes: { thickness: 2, side: 'outside' } }).doc.implicit?.fields[shell.id],
    ).toMatchObject({ thickness: 2, side: 'outside' });
    const moved = ok(box.doc, 'transform_field', { field: box.id, position: [1, 0, 0] });
    expect(ok(moved.doc, 'edit_field', { id: moved.id, changes: { scale: 2 } }).doc.implicit?.fields[moved.id]).toMatchObject({ scale: 2 });
    const z = ok(box.doc, 'create_scalar_field', { kind: 'coordinate', axis: 'z' });
    const ramp = ok(z.doc, 'create_scalar_field', { kind: 'ramp', input: z.id, inMin: 0, inMax: 1, outMin: 0, outMax: 1 });
    expect(ok(ramp.doc, 'edit_field', { id: ramp.id, changes: { outMax: 3 } }).doc.implicit?.fields[ramp.id]).toMatchObject({ outMax: 3 });
    expect(ok(z.doc, 'edit_field', { id: z.id, changes: { axis: 'x' } }).doc.implicit?.fields[z.id]).toMatchObject({ axis: 'x' });
    const noise = ok(box.doc, 'create_scalar_field', { kind: 'noise', frequency: 1 });
    expect(ok(noise.doc, 'edit_field', { id: noise.id, changes: { seed: 5 } }).doc.implicit?.fields[noise.id]).toMatchObject({ seed: 5 });
    const mix = ok(box.doc, 'create_scalar_field', { kind: 'mix', a: 1, b: 2, factor: 0.5 });
    expect(ok(mix.doc, 'edit_field', { id: mix.id, changes: { factor: 0.25 } }).doc.implicit?.fields[mix.id]).toMatchObject({
      factor: 0.25,
    });
    const arith = ok(box.doc, 'create_scalar_field', { kind: 'arith', operation: 'add', a: 1, b: 2 });
    expect(ok(arith.doc, 'edit_field', { id: arith.id, changes: { operation: 'max' } }).doc.implicit?.fields[arith.id]).toMatchObject({
      operation: 'max',
    });
    const distance = ok(box.doc, 'create_scalar_field', { kind: 'distance', toPoint: [0, 0, 0] });
    expect(
      ok(distance.doc, 'edit_field', { id: distance.id, changes: { toPoint: [1, 1, 1] } }).doc.implicit?.fields[distance.id],
    ).toMatchObject({ to: { point: [1, 1, 1] } });
  });

  it('edits the graph lattice, the solid source and a primitive of every shape', () => {
    const line = ok(empty(), 'draw_polyline', {
      points: [
        [0, 0],
        [10, 0],
      ],
    });
    const graph = ok(line.doc, 'add_graph_lattice', { sourceIds: [line.id], radiusStart: 0.5 });
    expect(
      ok(graph.doc, 'edit_field', { id: graph.id, changes: { radiusEnd: 0.25, cap: 'butt' } }).doc.implicit?.fields[graph.id],
    ).toMatchObject({ radiusStart: 0.5, radiusEnd: 0.25, cap: 'butt' });
    const box = ok(graph.doc, 'add_box', { size: [4, 4, 4] });
    const solid = ok(box.doc, 'field_from_solid', { entityId: box.id });
    const other = ok(solid.doc, 'add_box', { size: [6, 6, 6] });
    expect(ok(other.doc, 'edit_field', { id: solid.id, changes: { entityId: other.id } }).doc.implicit?.fields[solid.id]).toMatchObject({
      entityId: other.id,
    });
    const shapes: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [
        { shape: 'box', size: [2, 2, 2] },
        { size: [3, 3, 3], rounding: 0.2 },
      ],
      [{ shape: 'cylinder', radius: 1, height: 2 }, { height: 4 }],
      [{ shape: 'cone', radius: 1, height: 2 }, { radius: 2 }],
      [{ shape: 'capsule', radius: 1, height: 2 }, { radius: 0.5 }],
      [{ shape: 'torus', ringRadius: 3, tubeRadius: 1 }, { tubeRadius: 0.5 }],
      [{ shape: 'plane', normal: [0, 0, 1] }, { offset: 2 }],
    ];
    for (const [create, changes] of shapes) {
      const made = ok(empty(), 'add_field_primitive', create);
      const edited = ok(made.doc, 'edit_field', { id: made.id, changes: { ...changes, position: [1, 2, 3] } });
      expect(edited.doc.implicit?.fields[made.id]).toMatchObject({ op: 'primitive', position: [1, 2, 3] });
    }
  });

  it('refuses unknown nodes and keys and invalid values (the creating command validates the edit)', () => {
    const { doc, field } = ball(4);
    expectRefused(doc, run(doc, 'edit_field', { id: 'nope', changes: {} }), 'IMP_FIELD_NOT_FOUND');
    expectRefused(doc, run(doc, 'edit_field', { id: field, changes: { colour: 1 } }), 'IMP_PARAM_RANGE');
    expectRefused(doc, run(doc, 'edit_field', { id: field, changes: { radius: -1 } }), 'IMP_PARAM_RANGE');
    expectRefused(doc, run(doc, 'edit_field', { id: field, changes: { shape: 'box' } }), 'IMP_PARAM_RANGE');
  });

  it('refuses an edit that would make the graph cyclic', () => {
    const a = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
    const b = ok(a.doc, 'add_field_primitive', { shape: 'sphere', radius: 2, position: [3, 0, 0] });
    const first = ok(b.doc, 'combine_fields', { op: 'union', a: a.id, b: b.id });
    const second = ok(first.doc, 'combine_fields', { op: 'union', a: first.id, b: b.id });
    expectRefused(second.doc, run(second.doc, 'edit_field', { id: first.id, changes: { a: second.id } }), 'IMP_FIELD_CYCLE');
    expectRefused(second.doc, run(second.doc, 'edit_field', { id: first.id, changes: { b: first.id } }), 'IMP_FIELD_CYCLE');
    expect(ok(second.doc, 'edit_field', { id: second.id, changes: { b: a.id } }).doc.implicit?.fields[second.id]).toMatchObject({
      operands: [first.id, a.id],
    });
  });

  it('refuses an edit a dependent body cannot realise (budget) and leaves the document unchanged', () => {
    const { doc, field } = ball(4, 0.5);
    const refused = run(doc, 'edit_field', { id: field, changes: { radius: 5000 } });
    expectRefused(doc, refused, 'IMP_GRID_BUDGET');
    expect(refused.result.summary).toContain('edit_field');
  });

  it('is pure', () => {
    const { doc, field } = ball(3);
    expectPure(doc, () => run(doc, 'edit_field', { id: field, changes: { radius: 5 } }));
  });
});

describe('delete_field', () => {
  it('refuses a node that is read by another node or a body and lists the referrers', () => {
    const { doc, field, body } = ball(3);
    const offset = ok(doc, 'offset_field', { field, distance: 1 });
    const refused = run(offset.doc, 'delete_field', { id: field });
    expectRefused(offset.doc, refused, 'IMP_FIELD_IN_USE');
    expect(refused.result.error?.ids).toEqual(expect.arrayContaining([field, offset.id, body]));
    expectRefused(doc, run(doc, 'delete_field', { id: 'nope' }), 'IMP_FIELD_NOT_FOUND');
  });

  it('deletes an unused node, and with cascade the dependents and the bodies (the mesh entity leaves the document)', () => {
    const { doc, field, body } = ball(3);
    const lone = ok(doc, 'add_field_primitive', { shape: 'sphere', radius: 1 });
    const removedLone = ok(lone.doc, 'delete_field', { id: lone.id });
    expect(removedLone.doc.implicit?.fields[lone.id]).toBeUndefined();
    expect(removedLone.doc.implicit?.fields[field]).toBeDefined();
    const offset = ok(doc, 'offset_field', { field, distance: 1 });
    const cascade = ok(offset.doc, 'delete_field', { id: field, cascade: true });
    expect(cascade.doc.implicit?.fields[field]).toBeUndefined();
    expect(cascade.doc.implicit?.fields[offset.id]).toBeUndefined();
    expect(cascade.doc.implicit?.bodies[body]).toBeUndefined();
    expect(cascade.doc.entities[body]).toBeUndefined();
    expect(cascade.doc.order).not.toContain(body);
    expect(cascade.result.affected).toEqual(expect.arrayContaining([field, offset.id, body]));
  });

  it('is pure', () => {
    const { doc, field } = ball(3);
    expectPure(doc, () => run(doc, 'delete_field', { id: field, cascade: true }));
  });
});

describe('regenerate_implicit_bodies', () => {
  /** A TS engine under another name: bodies realised by it hash differently from the default engine. */
  const renamed: FieldEngine = {
    ...tsFieldEngine,
    name: 'other',
    determinism: 'other-libm',
    mesh: (...args) => {
      const meshed = tsFieldEngine.mesh(...args);
      return meshed.ok ? { ...meshed, provenance: { ...meshed.provenance, engine: 'other' } } : meshed;
    },
  };

  it('leaves up-to-date bodies alone and re-derives the ones another engine would realise differently', () => {
    const { doc, body } = ball(3);
    const fresh = ok(doc, 'regenerate_implicit_bodies', {});
    expect(fresh.result.affected).toEqual([]);
    expect(fresh.data['upToDate']).toEqual([body]);
    expect(fresh.doc).toBe(doc);
    setFieldEngine(renamed);
    const stale = ok(doc, 'regenerate_implicit_bodies', {});
    expect(stale.result.affected).toEqual([body]);
    expect(stale.doc.implicit?.bodies[body]?.engine).toBe('other');
    expect(stale.doc.implicit?.bodies[body]?.contentHash).not.toBe(doc.implicit?.bodies[body]?.contentHash);
    expect(ok(stale.doc, 'regenerate_implicit_bodies', {}).result.affected).toEqual([]);
  });

  it('re-derives the listed bodies regardless of staleness and refuses unknown ids', () => {
    const { doc, body } = ball(3);
    const forced = ok(doc, 'regenerate_implicit_bodies', { ids: [body] });
    expect(forced.data['upToDate']).toEqual([body]);
    expectRefused(doc, run(doc, 'regenerate_implicit_bodies', { ids: ['nope'] }), 'IMP_FIELD_NOT_FOUND');
  });

  it('reports the refusal of a body the engine cannot realise and keeps the document', () => {
    const { doc } = ball(3);
    setFieldEngine({
      ...tsFieldEngine,
      name: 'refusing',
      determinism: 'refusing',
      mesh: () => ({ ok: false, code: 'IMP_ENGINE_FAILED', message: 'no thanks' }),
    });
    expectRefused(doc, run(doc, 'regenerate_implicit_bodies', {}), 'IMP_ENGINE_FAILED');
  });

  it('is pure', () => {
    const { doc } = ball(3);
    setFieldEngine(renamed);
    expectPure(doc, () => run(doc, 'regenerate_implicit_bodies', {}));
  });
});

/** An in-memory mesh asset store keyed by a hash of the mesh (the host store is content addressed). */
function memoryStore(): { port: MeshAssetPort; writes: () => number } {
  const meshes = new Map<string, MeshData>();
  const refs = new Map<string, MeshAssetRef>();
  let writes = 0;
  const port: MeshAssetPort = {
    manifest: (key) => refs.get(key) ?? null,
    readMesh: (key) => meshes.get(key) ?? null,
    writeMesh: (mesh): MeshAssetRef => {
      writes += 1;
      let hash = 7;
      for (const v of [mesh.positions.length, mesh.indices.length, ...mesh.positions.slice(0, 30), ...mesh.indices.slice(-30)])
        hash = (hash * 31 + Math.round(v * 1000)) >>> 0;
      const key = hash.toString(16).padStart(64, '0');
      meshes.set(key, mesh);
      const ref: MeshAssetRef = {
        key,
        triangles: mesh.indices.length / 3,
        vertices: mesh.positions.length / 3,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      };
      refs.set(key, ref);
      return ref;
    },
    readFile: () => null,
  };
  return { port, writes: () => writes };
}

const withAssets = (
  doc: CadDocument,
  name: string,
  params: Record<string, unknown>,
  meshAssets: MeshAssetPort,
): ReturnType<typeof execute> => execute(doc, name, params, { ...defaultContext(), meshAssets });

describe('mesh asset store (D3 host cache)', () => {
  it('a body above the inline cap keeps its full mesh in the store and a display level of detail in the document; queries read the store', () => {
    const store = memoryStore();
    const field = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 10 });
    const inline = ok(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.25 });
    expect((inline.doc.entities[inline.id] as MeshSolidEntity).asset).toBeUndefined();
    const created = withAssets(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.25 }, store.port);
    const id = created.affected[0] ?? '';
    const entity = created.document.entities[id] as MeshSolidEntity;
    expect(entity.asset).toBeDefined();
    expect(entity.mesh.indices.length / 3).toBeLessThan(120_000);
    expect(created.document.implicit?.bodies[id]?.asset?.key).toBe(entity.asset?.key);
    expect(store.writes()).toBe(1);
    const props = withAssets(created.document, 'implicit_properties', { id }, store.port);
    expect((props.data as Record<string, number>)['volumeMesh']).toBeCloseTo((4 / 3) * Math.PI * 1000, -1);
    expect(run(created.document, 'implicit_properties', { id }).result.error?.code).toBe('IMP_ASSET_MISSING');
    const verdict = withAssets(created.document, 'check_implicit', { id }, store.port);
    expect((verdict.data as Record<string, unknown>)['status']).toBeDefined();
    expect(run(created.document, 'check_implicit', { id }).result.error?.code).toBe('IMP_ASSET_MISSING');
  }, 60_000);

  it('a saved document re-derives its bodies from the store without evaluating the field, and from the field without a store', () => {
    const store = memoryStore();
    const field = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 10 });
    const created = withAssets(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.25 }, store.port);
    const id = created.affected[0] ?? '';
    const text = serializeDocument(created.document);
    expect(text.length).toBeLessThan(60_000);
    setMeshAssetPort(store.port);
    let calls = 0;
    setFieldEngine({
      ...tsFieldEngine,
      mesh: (...args) => {
        calls += 1;
        return tsFieldEngine.mesh(...args);
      },
    });
    const loaded = deserializeDocument(text);
    expect(calls).toBe(0);
    expect((loaded.entities[id] as MeshSolidEntity).asset?.key).toBe(created.document.implicit?.bodies[id]?.asset?.key);
    setMeshAssetPort(null);
    const without = deserializeDocument(text);
    expect((without.entities[id] as MeshSolidEntity).asset).toBeUndefined();
    expect(calls).toBeGreaterThan(0);
  }, 120_000);
});

describe('dual contouring bodies keep their mesher when re-derived', () => {
  it('edit_field re-meshes with dual contouring and regenerate_implicit_bodies then finds the body up to date', () => {
    const field = ok(empty(), 'add_field_primitive', { shape: 'box', size: [4, 4, 4] });
    const body = ok(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.5, mesher: 'dual_contouring' });
    const edited = ok(body.doc, 'edit_field', { id: field.id, changes: { size: [5, 5, 5] } });
    expect(edited.doc.implicit?.bodies[body.id]?.mesher).toBe('dual_contouring');
    const again = ok(edited.doc, 'regenerate_implicit_bodies', {});
    expect(again.result.affected).toEqual([]);
    expect(again.data['upToDate']).toEqual([body.id]);
  });
});

describe('a host that cannot hold or realise a stored body', () => {
  it('keeps a coarse display mesh with the asset reference and reports IMP_ASSET_MISSING instead of dropping the body', () => {
    const store = memoryStore();
    const field = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 10 });
    const created = withAssets(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.25 }, store.port);
    const id = created.affected[0] ?? '';
    const text = serializeDocument(created.document);
    setFieldEngine({ ...tsFieldEngine, limits: { ...tsFieldEngine.limits, maxTriangles: 40_000 } });
    const loaded = deserializeDocument(text);
    const entity = loaded.entities[id] as MeshSolidEntity;
    expect(entity.mesh.indices.length / 3).toBeGreaterThan(100);
    expect(entity.asset?.key).toBe(created.document.implicit?.bodies[id]?.asset?.key);
    expect(loaded.order).toContain(id);
    expect(run(loaded, 'implicit_properties', { id }).result.error?.code).toBe('IMP_ASSET_MISSING');
    expect(implicitDocument.afterLoad?.(loaded)?.[0]).toContain('IMP_ASSET_MISSING');
  }, 120_000);
});

describe('an engine that fails to evaluate', () => {
  it('is surfaced as IMP_ENGINE_FAILED by evaluate_field and section_field, never as NaN values', () => {
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
    setFieldEngine({
      ...tsFieldEngine,
      evaluate: (_program, points) => ({
        values: new Float64Array(points.length / 3).fill(NaN),
        gradients: null,
        nonFinite: points.length / 3,
        failure: { code: 'IMP_ENGINE_FAILED', message: 'native job failed' },
      }),
    });
    expectRefused(sphere.doc, run(sphere.doc, 'evaluate_field', { field: sphere.id, points: [[0, 0, 0]] }), 'IMP_ENGINE_FAILED');
    expectRefused(
      sphere.doc,
      run(sphere.doc, 'section_field', { id: sphere.id, plane: { origin: [0, 0, 0], normal: [0, 0, 1] }, size: 6 }),
      'IMP_ENGINE_FAILED',
    );
  });
});

describe('an engine that fails inside a beam lattice or its properties', () => {
  const failing: FieldEngine = {
    ...tsFieldEngine,
    evaluate: (_program, points) => ({
      values: new Float64Array(points.length / 3).fill(NaN),
      gradients: null,
      nonFinite: points.length / 3,
      failure: { code: 'IMP_ENGINE_FAILED', message: 'native job failed' },
    }),
  };

  const strutBody = (radius: number | string, doc: CadDocument, region: string): { doc: CadDocument; body: string; lattice: string } => {
    const lattice = ok(doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 5, radius, origin: [0, 0, 0], region });
    const body = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.4 });
    return { doc: body.doc, body: body.id, lattice: lattice.id };
  };

  const skippedReason = (doc: CadDocument, body: string): string => {
    const data = ok(doc, 'export_3mf', { entityIds: [body], beamLattice: true }).data as {
      beamLattice: { skipped: Array<{ reason: string }> };
    };
    return data.beamLattice.skipped[0]?.reason ?? '';
  };

  it('a region sample failure keeps the lattice as a mesh and says why; a graded radius law failure does the same', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [10, 10, 10], position: [5, 5, 5] });
    const constant = strutBody(0.4, box.doc, box.id);
    const x = ok(constant.doc, 'create_scalar_field', { kind: 'coordinate', axis: 'x' });
    const ramp = ok(x.doc, 'create_scalar_field', { kind: 'ramp', input: x.id, inMin: 0, inMax: 10, outMin: 0.3, outMax: 0.5 });
    const graded = strutBody(ramp.id, ramp.doc, box.id);
    setFieldEngine(failing);
    expect(skippedReason(constant.doc, constant.body)).toContain('native job failed');
    expect(skippedReason(graded.doc, graded.body)).toContain('native job failed');
  });

  it('lattice_properties reports the cut beams as unavailable instead of counting NaN as inside', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [10, 10, 10], position: [5, 5, 5] });
    const lattice = ok(box.doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 5, radius: 0.4, origin: [0, 0, 0], region: box.id });
    setFieldEngine(failing);
    const data = ok(lattice.doc, 'lattice_properties', { id: lattice.id }).data;
    expect(data['cutBeams']).toMatchObject({ available: false });
    expect(String((data['cutBeams'] as { reason: string }).reason)).toContain('native job failed');
  });
});

describe('a stored body this host can only show coarsely', () => {
  it('leaves a body that reads it unrealised with its record and hash untouched, flags it, refuses to measure it, and restores A with the store', () => {
    const store = memoryStore();
    const field = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 10 });
    const created = withAssets(field.doc, 'create_implicit_body', { field: field.id, voxel: 0.25 }, store.port);
    const idA = created.affected[0] ?? '';
    const model = created.document.implicit;
    const recordA = model?.bodies[idA];
    if (model === undefined || recordA === undefined) throw new Error('body A expected');
    const { asset, ...recordWithoutAsset } = recordA;
    void asset;
    const solid: FieldNode = { id: 'fld-solid', op: 'solid', entityId: idA };
    const recordB = { ...recordWithoutAsset, id: 'imp-b', field: 'fld-solid', voxel: 2, contentHash: 'hash-of-b-as-saved', name: 'B' };
    const withB: CadDocument = {
      ...created.document,
      implicit: { ...model, fields: { ...model.fields, 'fld-solid': solid }, bodies: { ...model.bodies, 'imp-b': recordB } },
    };
    const text = serializeDocument(withB);

    setMeshAssetPort(null);
    setFieldEngine({ ...tsFieldEngine, limits: { ...tsFieldEngine.limits, maxTriangles: 40_000 } });
    const coarse = deserializeDocument(text);
    expect((coarse.entities[idA] as MeshSolidEntity).asset?.key).toBe(recordA.asset?.key);
    expect(coarse.entities['imp-b']).toBeUndefined();
    expect(coarse.order).not.toContain('imp-b');
    expect(coarse.implicit?.bodies['imp-b']?.contentHash).toBe('hash-of-b-as-saved');
    const warnings = implicitDocument.afterLoad?.(coarse) ?? [];
    expect(warnings.some((w) => w.startsWith('IMP_BODY_STALE') && w.includes("'imp-b'"))).toBe(true);
    expect(warnings.some((w) => w.startsWith('IMP_ASSET_MISSING') && w.includes("'" + idA + "'"))).toBe(true);
    expectRefused(coarse, run(coarse, 'implicit_properties', { id: 'imp-b' }), 'IMP_BODY_STALE');
    expectRefused(coarse, run(coarse, 'check_implicit', { id: 'imp-b' }), 'IMP_BODY_STALE');

    setFieldEngine(null);
    setMeshAssetPort(store.port);
    const full = deserializeDocument(text);
    expect((full.entities[idA] as MeshSolidEntity).asset?.key).toBe(recordA.asset?.key);
    expect((implicitDocument.afterLoad?.(full) ?? []).filter((w) => w.includes("'" + idA + "'"))).toEqual([]);
  }, 180_000);
});
