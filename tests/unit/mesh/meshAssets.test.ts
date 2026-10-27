/** 07 MSH M3: the content-addressed mesh asset store seen from the commands (FR-MSH-02 / 27, VC-MSH-31): import by fileKey, attach, results above the inline cap, full-resolution reads and exports. */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { ExecutionContext } from '@core/commands/types';
import { MESH_INLINE_TRIANGLE_CAP, MESH_LOD_TRIANGLES, type MeshAssetPort, placeMesh } from '@core/geometry/mesh/assets';
import { composeMeshEngines } from '@core/geometry/mesh/engine';
import { fastMeasure } from '@core/geometry/mesh/fastMeasure';
import { lodMesh } from '@core/geometry/mesh/lod';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import { analyzeIndexedMesh } from '@core/geometry/mesh/analysis';
import { type CadDocument, createEmptyDocument, type MeshData, type MeshSolidEntity } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { icosphere, relativeError } from '../../helpers/meshFixtures';
import { memoryMeshAssets } from '../../helpers/memoryMeshAssets';

/** The TypeScript engine with its caps lifted: stands in for the native engine so big results exist. */
const uncapped = {
  name: 'uncapped',
  capabilities: () => new Map(['cut', 'smooth', 'decimate', 'analyze'].map((op) => [op as 'cut', Infinity])),
  run: tsMeshEngine.run,
};

const ctxOf = (assets: MeshAssetPort | null): ExecutionContext => ({
  ...defaultContext(),
  meshAssets: assets,
  meshProcessing: composeMeshEngines([uncapped]),
});

const run = (doc: CadDocument, name: string, params: unknown, assets: MeshAssetPort | null): ReturnType<typeof execute> =>
  execute(doc, name, params, ctxOf(assets));

/** Binary STL bytes of an indexed mesh (float32 coordinates). */
function binaryStl(mesh: MeshData): Uint8Array {
  const triangles = mesh.indices.length / 3;
  const bytes = new Uint8Array(84 + triangles * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles, true);
  for (let t = 0; t < triangles; t++) {
    for (let k = 0; k < 3; k++) {
      const v = (mesh.indices[t * 3 + k] as number) * 3;
      for (let a = 0; a < 3; a++) view.setFloat32(84 + t * 50 + 12 + k * 12 + a * 4, mesh.positions[v + a] as number, true);
    }
  }
  return bytes;
}

const big = icosphere(10, 7); // 327 680 triangles
const small = icosphere(10, 2); // 320 triangles

function bigScan(assets = memoryMeshAssets()): {
  doc: CadDocument;
  id: string;
  assets: ReturnType<typeof memoryMeshAssets>;
  fileKey: string;
} {
  const fileKey = assets.putFile(binaryStl(big));
  const result = run(createEmptyDocument(), 'import_mesh_file', { fileKey, units: 'mm', name: 'scan' }, assets);
  return { doc: result.document, id: result.affected[0] as string, assets, fileKey };
}

describe('lod and placement', () => {
  it('clusters a big mesh near the target and leaves a small one alone', () => {
    const lod = lodMesh(big, MESH_LOD_TRIANGLES);
    expect(lod.indices.length / 3).toBeGreaterThan(MESH_LOD_TRIANGLES * 0.5);
    expect(lod.indices.length / 3).toBeLessThanOrEqual(MESH_LOD_TRIANGLES * 1.25);
    expect(lodMesh(small, MESH_LOD_TRIANGLES)).toBe(small);
    const tiny = lodMesh(big, 20);
    expect(tiny.indices.length / 3).toBeLessThanOrEqual(40);
    const extent = (mesh: MeshData): number[] =>
      Array.from({ length: 3 }, (_, a) => mesh.positions.reduce((max, v, i) => (i % 3 === a ? Math.max(max, v) : max), -Infinity));
    extent(lod).forEach((value, a) => expect(Math.abs(value - (extent(big)[a] as number))).toBeLessThan(0.5));
  });

  it('places entity-local triangles by position and Euler rotation', () => {
    const mesh = { positions: [1, 0, 0, 0, 1, 0, 0, 0, 1], indices: [0, 1, 2] };
    expect(placeMesh(mesh, [0, 0, 0], [0, 0, 0])).toBe(mesh);
    expect(placeMesh(mesh, [1, 2, 3], [0, 0, 0]).positions).toEqual([2, 2, 3, 1, 3, 3, 1, 2, 4]);
    const turned = placeMesh(mesh, [0, 0, 0], [0, 0, Math.PI / 2]).positions;
    expect(turned[0]).toBeCloseTo(0, 12);
    expect(Math.abs(Math.abs(turned[1] as number) - 1)).toBeLessThan(1e-12);
  });

  it('measures like the full analysis on a mesh above the fast-path size', () => {
    const sphere = icosphere(10, 6);
    const fast = fastMeasure(sphere);
    const full = analyzeIndexedMesh(sphere.positions, sphere.indices, { selfIntersections: false, maxListed: 0 });
    expect(fast.closed).toBe(true);
    expect(relativeError(fast.volume as number, full.volume as number)).toBeLessThan(1e-12);
    expect(relativeError(fast.area, full.area)).toBeLessThan(1e-12);
    expect([fast.faces, fast.vertices, fast.boundaryEdges, fast.nonManifoldEdges, fast.inconsistentEdges]).toEqual([81920, 40962, 0, 0, 0]);
    const open = { positions: sphere.positions, indices: sphere.indices.slice(3) };
    const broken = fastMeasure(open);
    expect([broken.closed, broken.volume, broken.boundaryEdges]).toEqual([false, null, 3]);
  });
});

describe('import_mesh_file by fileKey (the document keeps 64 hex characters, not the file)', () => {
  it('stores a big import in the asset store with a display LOD, and the document stays small', () => {
    const { doc, id, assets, fileKey } = bigScan();
    const entity = doc.entities[id] as MeshSolidEntity;
    expect(entity.asset).toMatchObject({ triangles: 327680, vertices: 163842 });
    expect(entity.asset?.key).toMatch(/^[0-9a-f]{64}$/);
    expect(entity.mesh.indices.length / 3).toBeLessThanOrEqual(MESH_LOD_TRIANGLES * 1.25);
    expect(entity.meshSource).toMatchObject({ format: 'stl-binary', verified: false });
    expect(JSON.stringify(doc).length).toBeLessThan(8_000_000);
    expect(assets.meshes.get(entity.asset?.key as string)?.indices.length).toBe(327680 * 3);
    expect(doc.featureHistory[0]?.params).toMatchObject({ fileKey });
    expect(JSON.stringify(doc.featureHistory)).not.toContain('base64');
  });

  it('keeps a small import inline and refuses a missing file, a missing store and ambiguous input', () => {
    const assets = memoryMeshAssets();
    const fileKey = assets.putFile(binaryStl(small));
    const inline = run(createEmptyDocument(), 'import_mesh_file', { fileKey, units: 'mm' }, assets);
    expect((inline.document.entities[inline.affected[0] as string] as MeshSolidEntity).asset).toBeUndefined();
    const doc = createEmptyDocument();
    const gone = run(doc, 'import_mesh_file', { fileKey: 'a'.repeat(64), units: 'mm' }, assets);
    expectNoOp(gone, doc);
    expect(gone.error?.code).toBe('MESH_ASSET_MISSING');
    expect(run(doc, 'import_mesh_file', { fileKey, units: 'mm' }, null).error?.code).toBe('MESH_ASSET_UNAVAILABLE');
    expect(run(doc, 'import_mesh_file', { fileKey, text: 'x', units: 'mm' }, assets).error?.code).toBe('MESH_PARAM_INVALID');
    const bigFile = assets.putFile(binaryStl(big));
    expect(run(doc, 'import_mesh_file', { fileKey: bigFile, units: 'mm' }, null).error?.code).toBe('MESH_ASSET_UNAVAILABLE');
  });

  it('replays to the same asset-backed entity', () => {
    const { doc, id, assets } = bigScan();
    const replayed = execute(doc, 'replay_history', {}, ctxOf(assets));
    expect(replayed.error).toBeUndefined();
    expect((replayed.document.entities[id] as MeshSolidEntity).asset).toEqual((doc.entities[id] as MeshSolidEntity).asset);
  });
});

describe('attach_mesh_asset', () => {
  it('attaches a big asset with its LOD and a small one inline, carrying the importer provenance', () => {
    const assets = memoryMeshAssets();
    const ref = assets.writeMesh(big);
    const doc = createEmptyDocument();
    const attached = run(doc, 'attach_mesh_asset', { assetKey: ref.key, name: 'scan', position: [1, 2, 3] }, assets);
    expect(attached.error).toBeUndefined();
    const entity = attached.document.entities[attached.affected[0] as string] as MeshSolidEntity;
    expect(entity.asset?.key).toBe(ref.key);
    expect(entity.position).toEqual([1, 2, 3]);
    expect((attached.data as { inline: boolean; lodTriangles: number }).inline).toBe(false);
    const smallRef = assets.writeMesh(small);
    const inline = run(doc, 'attach_mesh_asset', { assetKey: smallRef.key }, assets);
    expect((inline.document.entities[inline.affected[0] as string] as MeshSolidEntity).asset).toBeUndefined();
    expect((inline.data as { inline: boolean }).inline).toBe(true);
    expect((inline.data as { unverified: boolean }).unverified).toBe(true);
    expectPure(doc, () => run(doc, 'attach_mesh_asset', { assetKey: ref.key }, assets));
  });

  it('refuses an unknown key and a missing store', () => {
    const assets = memoryMeshAssets();
    const doc = createEmptyDocument();
    const missing = run(doc, 'attach_mesh_asset', { assetKey: 'b'.repeat(64) }, assets);
    expectNoOp(missing, doc);
    expect(missing.error?.code).toBe('MESH_ASSET_MISSING');
    expect(run(doc, 'attach_mesh_asset', { assetKey: 'b'.repeat(64) }, null).error?.code).toBe('MESH_ASSET_UNAVAILABLE');
    expect(run(doc, 'attach_mesh_asset', { assetKey: 'not-a-key' }, assets).error?.code).toBe('CMD_INVALID_PARAMS');
  });
});

describe('commands read the full-resolution asset', () => {
  it('cuts a big asset-backed mesh: the half above the inline cap becomes a new asset, volumes are full resolution', () => {
    const { doc, id, assets } = bigScan();
    const before = assets.meshes.size;
    const cut = run(doc, 'cut_mesh', { id, plane: { origin: [0, 0, 0], normal: [0, 0, 1] }, keep: 'both', keepSource: true }, assets);
    expect(cut.error).toBeUndefined();
    const volumes = (cut.data as { volumes: { positive: number; negative: number } }).volumes;
    const full = fastMeasure(big).volume as number;
    expect(Math.abs(volumes.positive + volumes.negative - full) / full).toBeLessThan(1e-9);
    expect(assets.meshes.size).toBe(before + 2);
    for (const resultId of cut.affected) {
      const entity = cut.document.entities[resultId] as MeshSolidEntity;
      expect(entity.asset?.triangles).toBeGreaterThan(MESH_INLINE_TRIANGLE_CAP);
      expect(entity.mesh.indices.length / 3).toBeLessThanOrEqual(MESH_LOD_TRIANGLES * 1.25);
    }
    expect(JSON.stringify(cut.document).length).toBeLessThan(20_000_000);
  });

  it('refuses a result above the cap without a store, and an asset-backed input when the store is gone or the asset missing', () => {
    const { doc, id, assets } = bigScan();
    const plane = { origin: [0, 0, 0], normal: [0, 0, 1] };
    const unavailable = run(doc, 'cut_mesh', { id, plane }, null);
    expectNoOp(unavailable, doc);
    expect(unavailable.error?.code).toBe('MESH_ASSET_UNAVAILABLE');
    assets.meshes.clear();
    const missing = run(doc, 'cut_mesh', { id, plane }, assets);
    expect(missing.error?.code).toBe('MESH_ASSET_MISSING');
    expect(run(doc, 'analyze_mesh', { id }, assets).error?.code).toBe('MESH_ASSET_MISSING');
    const lodOnly = run(doc, 'measure_deviation', { id, referenceId: id, symmetric: true }, assets);
    // the query degrades to the display mesh, and the command's own check of an asset-backed input then refuses by name
    expect(lodOnly.error?.code).toBe('MESH_ASSET_MISSING');
  });

  it('is pure', () => {
    const { doc, id, assets } = bigScan();
    expectPure(doc, () => run(doc, 'cut_mesh', { id, plane: { origin: [0, 0, 0], normal: [1, 0, 0] } }, assets));
  });
});

describe('exports read the asset at full resolution (VC-MSH-31)', () => {
  it('export_stl, export_obj, export_3mf and export_gltf carry every triangle, never the LOD', () => {
    const { doc, assets } = bigScan();
    const stl = run(doc, 'export_stl', { format: 'binary' }, assets);
    expect(stl.error).toBeUndefined();
    expect((stl.data as { triangleCount: number }).triangleCount).toBe(327680);
    const threeMf = run(doc, 'export_3mf', {}, assets);
    expect(threeMf.summary).toContain('327680');
    expect(run(doc, 'export_obj', {}, assets).summary).toContain('327680 triangles');
    expect(run(doc, 'export_gltf', { binary: true }, assets).summary).toContain('327680 triangles');
  });

  it('refuses an export whose asset cannot be read, never writing the LOD', () => {
    const { doc, assets } = bigScan();
    assets.meshes.clear();
    for (const name of ['export_stl', 'export_obj', 'export_3mf', 'export_gltf']) {
      const refused = run(doc, name, {}, assets);
      expect(refused.error?.code, name).toBe('MESH_ASSET_MISSING');
      expect(run(doc, name, {}, null).error?.code, name).toBe('MESH_ASSET_UNAVAILABLE');
    }
  });
});

describe('persistence of the asset reference', () => {
  const envelope = (doc: CadDocument): string => JSON.stringify({ format: 'llull-document', version: 3, document: doc });
  const loadError = (json: string): string => {
    try {
      deserializeDocument(json);
    } catch (error) {
      return (error as Error).message;
    }
    return '';
  };

  it('round-trips an asset-backed mesh and refuses a damaged reference by name', () => {
    const { doc, id } = bigScan();
    expect(deserializeDocument(serializeDocument(doc))).toEqual(doc);
    const entity = doc.entities[id] as MeshSolidEntity;
    const withAsset = (asset: unknown): string =>
      envelope({ ...doc, entities: { ...doc.entities, [id]: { ...entity, asset } as MeshSolidEntity } });
    expect(loadError(withAsset({ ...entity.asset, key: 'xyz' }))).toContain('asset');
    expect(loadError(withAsset({ ...entity.asset, triangles: -1 }))).toContain('asset');
    expect(loadError(withAsset({ ...entity.asset, bounds: { min: [0, 0] } }))).toContain('asset');
    expect(loadError(withAsset('nope'))).toContain('asset');
    const grouped = envelope({
      ...doc,
      entities: { ...doc.entities, [id]: { ...entity, faceGroups: [{ id: 'g', faces: [[0, 300_000]] }] } as MeshSolidEntity },
    });
    expect(loadError(grouped)).toBe('');
  });
});

describe('commands that read triangles see the full-resolution asset (MESH_ASSET_LOD_ONLY otherwise)', () => {
  const counting = (assets: ReturnType<typeof memoryMeshAssets>): { port: MeshAssetPort; reads: () => number } => {
    let count = 0;
    return {
      port: {
        ...assets,
        readMesh: (key) => {
          count++;
          return assets.readMesh(key);
        },
      },
      reads: () => count,
    };
  };

  it('mass_properties measures the stored mesh, not the display level of detail, and leaves the document alone', () => {
    const { doc, id, assets } = bigScan();
    const entity = doc.entities[id] as MeshSolidEntity;
    expect(entity.mesh.indices.length / 3).toBeLessThan(big.indices.length / 3);
    const result = run(doc, 'mass_properties', { entityId: id }, assets);
    expect(result.error).toBeUndefined();
    expect(result.document).toBe(doc);
    const volume = (result.data as { volume: number }).volume;
    expect(relativeError(volume, fastMeasure(big).volume as number)).toBeLessThan(1e-6);
    const lodVolume = fastMeasure(entity.mesh).volume as number;
    expect(Math.abs(volume - lodVolume)).toBeGreaterThan(Math.abs(volume - (fastMeasure(big).volume as number)));
  });

  it('one-way measure_deviation reads the asset; an unreadable asset refuses by name', () => {
    const { doc, id, assets } = bigScan();
    const counted = counting(assets);
    const result = run(doc, 'measure_deviation', { id, points: [[0, 0, 10.5]] }, counted.port);
    expect(result.error).toBeUndefined();
    expect(counted.reads()).toBeGreaterThan(0);
    expect((result.data as { max: number }).max).toBeCloseTo(0.5, 2);
    const noStore = run(doc, 'measure_deviation', { id, points: [[0, 0, 10.5]] }, null);
    expect(noStore.document).toBe(doc);
    expect(noStore.error).toBeUndefined();
    expect((noStore.data as { lodOnly?: string[] }).lodOnly).toEqual([id]);
    expect(noStore.summary).toContain('MESH_ASSET_LOD_ONLY');
    const empty = memoryMeshAssets();
    const missing = run(doc, 'mass_properties', { entityId: id }, empty);
    expect(missing.error).toBeUndefined();
    expect((missing.data as { lodOnly?: string[] }).lodOnly).toEqual([id]);
    expect(missing.document).toBe(doc);
  });

  it('a plugin consumer (frontal_area) refuses without the asset and measures with it', () => {
    const { doc, id, assets } = bigScan();
    const refused = run(doc, 'frontal_area', { entityIds: [id] }, null);
    expect(refused.error).toBeUndefined();
    expect((refused.data as { lodOnly?: string[] }).lodOnly).toEqual([id]);
    const counted = counting(assets);
    const measured = run(doc, 'frontal_area', { entityIds: [id] }, counted.port);
    expect(measured.error).toBeUndefined();
    expect(counted.reads()).toBeGreaterThan(0);
    expect(measured.document).toBe(doc);
  });

  it('a mutating reader keeps the display level of detail in its result', () => {
    const { doc, id, assets } = bigScan();
    const before = (doc.entities[id] as MeshSolidEntity).mesh;
    const result = run(doc, 'scale_nonuniform', { id, factors: [1, 1, 1] }, assets);
    const entity = result.document.entities[id] as MeshSolidEntity | undefined;
    if (entity?.kind === 'mesh') expect(entity.mesh.indices.length).toBeLessThanOrEqual(before.indices.length);
  });
});

describe('runWithFullMeshes restores the display level of detail', () => {
  it('puts the LOD mesh back where the result still carries the swapped mesh, and keeps changed meshes', async () => {
    const { runWithFullMeshes } = await import('@core/commands/meshAssetView');
    const { doc, id, assets } = bigScan();
    const lod = (doc.entities[id] as MeshSolidEntity).mesh;
    const named = runWithFullMeshes(doc, 'probe', { entityId: id }, ctxOf(assets), false, false, (view) => {
      expect((view.entities[id] as MeshSolidEntity).mesh).not.toBe(lod);
      return { document: { ...view, nextStepNumber: 99 }, summary: 'ok', affected: [id] };
    });
    expect(named.document.nextStepNumber).toBe(99);
    expect((named.document.entities[id] as MeshSolidEntity).mesh).toBe(lod);
    const edited = runWithFullMeshes(doc, 'probe', {}, ctxOf(assets), false, false, (view) => ({
      document: { ...view, entities: { ...view.entities, [id]: { ...(view.entities[id] as MeshSolidEntity), mesh: small } } },
      summary: 'ok',
      affected: [id],
    }));
    expect((edited.document.entities[id] as MeshSolidEntity).mesh).toBe(small);
    const untouched = runWithFullMeshes(doc, 'probe', {}, ctxOf(assets), false, false, (view) => ({
      document: view,
      summary: 'ok',
      affected: [],
    }));
    expect(untouched.document).toBe(doc);
  });
});
