/**
 * PERF1 item 8: volume, area and the closed-manifold answer of a body mesh come from the field engine when it returns them (the native engine
 * does) and are remembered per mesh object and per mesh asset key; otherwise TypeScript walks the triangles, with the same answers.
 * The fake engines below return figures that are NOT those of their mesh: only so that a test can see which source an answer came from.
 */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { FieldEngine, FieldMeshResult } from '@core/geometry/field/engineTypes';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import type { CadDocument, MeshData, MeshSolidEntity } from '@core/model/types';
import { bindMeshAsset, bodyMeshIsClosedManifold, bodyMeshMeasuresOf, rememberMeshResult } from '@implicit/meshFacts';
import { isClosedManifold, meshMeasures } from '@lib/isosurface/measures';
import { memoryMeshAssets } from '../../helpers/memoryMeshAssets';
import { empty, ok } from './helpers';

const MARK = { volume: 123.5, area: 77.25 };

const engineWith = (extra: Partial<FieldMeshResult>): FieldEngine => ({
  ...tsFieldEngine,
  name: 'fake',
  mesh: (...args) => {
    const result = tsFieldEngine.mesh(...args);
    return result.ok ? { ...result, ...extra } : result;
  },
});

const contextOf = (fieldEngine: FieldEngine, extra: Partial<ExecutionContext> = {}): ExecutionContext => ({
  ...defaultContext(),
  fieldEngine,
  ...extra,
});

function data(doc: CadDocument, name: string, params: Record<string, unknown>, context: ExecutionContext): Record<string, unknown> {
  const result = execute(doc, name, params, context);
  expect(result.error, result.summary).toBeUndefined();
  return result.data as Record<string, unknown>;
}

function body(
  radius: number,
  voxel: number,
  context: ExecutionContext,
): { doc: CadDocument; id: string; created: Record<string, unknown> } {
  const field = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius });
  const result = execute(field.doc, 'create_implicit_body', { field: field.id, voxel }, context);
  expect(result.error, result.summary).toBeUndefined();
  return { doc: result.document, id: result.affected[0] ?? '', created: result.data as Record<string, unknown> };
}

const codes = (checked: Record<string, unknown>): string[] =>
  (checked['findings'] as Array<{ code: string }>).map((finding) => finding.code);

/** The document as another process would hold it: equal content, other mesh objects. */
const reloaded = (doc: CadDocument): CadDocument => structuredClone(doc);

const bits = (value: number): string => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16);
};

/** The 12 triangles of a cube over 8 vertices (the index list of the Rust twin's tests). */
const CUBE_INDICES = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];

const tetrahedron = (): MeshData => ({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3] });

const fakeResult = (mesh: MeshData, extra: Partial<FieldMeshResult>): FieldMeshResult => ({
  ok: true,
  mesh,
  closedManifold: true,
  samples: 0,
  evaluatedSamples: 0,
  prunedFraction: 0,
  maxVertexResidual: 0,
  nonFiniteSamples: 0,
  mesher: 'tetra',
  mesherFallback: false,
  provenance: { engine: 'fake', device: 'cpu', deterministic: true, voxel: 1 },
  ...extra,
});

describe('meshMeasures is the reference of the native twin (solver/crates/llull-field/src/mesh_measures.rs)', () => {
  it('gives the bit patterns the Rust test pins for the same skewed hexahedron', () => {
    const positions = Array.from({ length: 24 }, (_, i) => i * 0.37 + ((i * 0.61) % 1) * 3.1 + 1 / (i + 3));
    const { volume, area } = meshMeasures({ positions, indices: CUBE_INDICES });
    expect([bits(volume), bits(area)]).toEqual(['c0339b859a5eab7e', '4051de15bdb33baa']);
  });
});

describe('a body mesh measured by its engine', () => {
  it('create_implicit_body and implicit_properties report the engine figures, with the counts of the mesh', () => {
    const context = contextOf(engineWith({ measures: MARK }));
    const { doc, id, created } = body(3, 0.5, context);
    const mesh = (doc.entities[id] as MeshSolidEntity).mesh;
    expect([created['volumeMesh'], created['area']]).toEqual([MARK.volume, MARK.area]);
    expect([created['triangles'], created['vertices']]).toEqual([mesh.indices.length / 3, mesh.positions.length / 3]);
    const properties = data(doc, 'implicit_properties', { id }, contextOf(tsFieldEngine));
    expect([properties['volumeMesh'], properties['area'], properties['volume']]).toEqual([MARK.volume, MARK.area, MARK.volume]);
  });

  it('check_implicit takes the closed-manifold answer the engine gave with the mesh', () => {
    const { doc, id, created } = body(3.1, 0.5, contextOf(engineWith({ closedManifold: false })));
    expect(created['closedManifold']).toBe(false);
    expect(codes(data(doc, 'check_implicit', { id }, contextOf(tsFieldEngine)))).toContain('IMP_CHECK_MESH_NOT_MANIFOLD');
  });

  it('a mesh met for the first time is measured in TypeScript: the same document in another process answers from its triangles', () => {
    const marked = body(3.2, 0.5, contextOf(engineWith({ measures: MARK, closedManifold: false })));
    const doc = reloaded(marked.doc);
    const mesh = (doc.entities[marked.id] as MeshSolidEntity).mesh;
    const properties = data(doc, 'implicit_properties', { id: marked.id }, contextOf(tsFieldEngine));
    expect([properties['volumeMesh'], properties['area']]).toEqual([meshMeasures(mesh).volume, meshMeasures(mesh).area]);
    expect(codes(data(doc, 'check_implicit', { id: marked.id }, contextOf(tsFieldEngine)))).not.toContain('IMP_CHECK_MESH_NOT_MANIFOLD');
  });
});

describe('lattice_properties', () => {
  it('takes the area of the nodal surface of one cell from the engine when it comes with the mesh, else from the triangles', () => {
    const lattice = ok(empty(), 'add_tpms_lattice', { kind: 'neovius', form: 'network', level: 0, cellSize: 4 });
    const fromEngine = data(lattice.doc, 'lattice_properties', { id: lattice.id }, contextOf(engineWith({ measures: MARK })));
    expect(fromEngine['specificSurface']).toBe(MARK.area / 64);
    const fromMesh = data(lattice.doc, 'lattice_properties', { id: lattice.id }, contextOf(tsFieldEngine));
    expect(fromMesh['specificSurface']).toBeGreaterThan(0.5);
    expect(fromMesh['specificSurface']).not.toBe(MARK.area / 64);
  });
});

describe('a body mesh measured in TypeScript (an engine that returns no measures)', () => {
  it('reports meshMeasures and isClosedManifold of the mesh, at creation and in the queries', () => {
    const context = contextOf(tsFieldEngine);
    const { doc, id, created } = body(3.3, 0.5, context);
    const mesh = (doc.entities[id] as MeshSolidEntity).mesh;
    const expected = meshMeasures(mesh);
    expect(expected.volume).toBeGreaterThan(100);
    expect([created['volumeMesh'], created['area'], created['triangles'], created['vertices']]).toEqual([
      expected.volume,
      expected.area,
      expected.triangles,
      expected.vertices,
    ]);
    expect(created['closedManifold']).toBe(isClosedManifold(mesh));
    for (const held of [doc, reloaded(doc)]) {
      const properties = data(held, 'implicit_properties', { id }, context);
      expect([properties['volumeMesh'], properties['area']]).toEqual([expected.volume, expected.area]);
      expect(codes(data(held, 'check_implicit', { id }, context))).not.toContain('IMP_CHECK_MESH_NOT_MANIFOLD');
    }
  });

  it('an open mesh is reported by check_implicit whichever way it is known', () => {
    const { doc, id } = body(3.4, 0.5, contextOf(tsFieldEngine));
    const entity = doc.entities[id] as MeshSolidEntity;
    const open: CadDocument = {
      ...doc,
      entities: { ...doc.entities, [id]: { ...entity, mesh: { positions: entity.mesh.positions, indices: entity.mesh.indices.slice(3) } } },
    };
    expect(codes(data(open, 'check_implicit', { id }, contextOf(tsFieldEngine)))).toContain('IMP_CHECK_MESH_NOT_MANIFOLD');
  });
});

describe('a body whose mesh lives in the mesh asset store', () => {
  it('keeps the engine figures by asset key: a mesh read again from the store (another object) is not walked', () => {
    const assets = memoryMeshAssets();
    const context = contextOf(engineWith({ measures: MARK }), { meshAssets: assets });
    const { doc, id, created } = body(9.7, 0.25, context);
    const key = (doc.entities[id] as MeshSolidEntity).asset?.key ?? '';
    expect(key).not.toBe('');
    expect(created['volumeMesh']).toBe(MARK.volume);
    const stored = assets.meshes.get(key) as MeshData;
    assets.meshes.set(key, { positions: [...stored.positions], indices: [...stored.indices] });
    const properties = data(doc, 'implicit_properties', { id }, contextOf(tsFieldEngine, { meshAssets: assets }));
    expect([properties['volumeMesh'], properties['area']]).toEqual([MARK.volume, MARK.area]);
    expect(codes(data(doc, 'check_implicit', { id }, contextOf(tsFieldEngine, { meshAssets: assets })))).not.toContain(
      'IMP_CHECK_MESH_NOT_MANIFOLD',
    );
  }, 120_000);

  it('measures in TypeScript a stored mesh nothing is known of, and refuses a missing one as before', () => {
    const assets = memoryMeshAssets();
    const { doc, id } = body(9.6, 0.25, contextOf(tsFieldEngine, { meshAssets: assets }));
    const key = (doc.entities[id] as MeshSolidEntity).asset?.key ?? '';
    const stored = assets.meshes.get(key) as MeshData;
    const properties = data(doc, 'implicit_properties', { id }, contextOf(tsFieldEngine, { meshAssets: assets }));
    expect(properties['volumeMesh']).toBe(meshMeasures(stored).volume);
    const without = execute(doc, 'implicit_properties', { id }, contextOf(tsFieldEngine, { meshAssets: memoryMeshAssets() }));
    expect(without.error?.code).toBe('IMP_ASSET_MISSING');
  }, 120_000);
});

describe('the memory of mesh facts', () => {
  it('computes each fact once per mesh object and shares it with the asset key', () => {
    const mesh = tetrahedron();
    expect(bodyMeshMeasuresOf(mesh)).toBe(bodyMeshMeasuresOf(mesh));
    expect(bodyMeshMeasuresOf(mesh).volume).toBeCloseTo(1 / 6, 12);
    expect(bodyMeshIsClosedManifold(mesh)).toBe(true);
    bindMeshAsset(mesh, 'facts-test-shared');
    const again = tetrahedron();
    bindMeshAsset(again, 'facts-test-shared');
    expect(bodyMeshMeasuresOf(again)).toBe(bodyMeshMeasuresOf(mesh));
  });

  it('keeps what an engine result says and never replaces a fact it already holds', () => {
    const mesh = tetrahedron();
    rememberMeshResult(fakeResult(mesh, { measures: MARK, closedManifold: false }));
    rememberMeshResult(fakeResult(mesh, { measures: { volume: 1, area: 1 }, closedManifold: true }));
    expect(bodyMeshMeasuresOf(mesh)).toEqual({ ...MARK, triangles: 4, vertices: 4 });
    expect(bodyMeshIsClosedManifold(mesh)).toBe(false);
    const bare = tetrahedron();
    rememberMeshResult(fakeResult(bare, {}));
    expect(bodyMeshMeasuresOf(bare).volume).toBeCloseTo(1 / 6, 12);
  });

  it('forgets the oldest asset key beyond 64 keys; the mesh is then measured again', () => {
    const first = tetrahedron();
    rememberMeshResult(fakeResult(first, { measures: MARK }));
    bindMeshAsset(first, 'facts-test-evict-0');
    const early = tetrahedron();
    bindMeshAsset(early, 'facts-test-evict-0');
    expect(bodyMeshMeasuresOf(early).volume).toBe(MARK.volume);
    for (let n = 1; n <= 64; n += 1) bindMeshAsset(tetrahedron(), `facts-test-evict-${n}`);
    const late = tetrahedron();
    bindMeshAsset(late, 'facts-test-evict-0');
    expect(bodyMeshMeasuresOf(late).volume).toBeCloseTo(1 / 6, 12);
  });
});
