/** Review fixes of the streamed 3MF writer: byte cap at command level, malformed meshes, soup counts, manifold on kept triangles, beam counts near the cap. */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { buildThreeMf } from '@core/commands/exchange/threeMf';
import { latticeObjectXml } from '@core/commands/exchange/threeMfBeamLattice';
import { ThreeMfInvalidMeshError, keptIndices } from '@core/commands/exchange/threeMfStream';
import { execute } from '@core/commands/registry';
import { collectExportParts } from '@core/geometry/entityTriangles';
import type { MeshAssetPort } from '@core/geometry/mesh/assets';
import type { CadDocument } from '@core/model/types';
import { empty, ok } from '../implicit/helpers';

/** A flat grid of 2 * 520 * 300 = 312000 triangles (above the 250000 streaming threshold). */
function gridMesh(): { positions: number[]; indices: number[] } {
  const [columns, rows] = [521, 301];
  const positions: number[] = [];
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < columns; c += 1) positions.push(c * 0.01, r * 0.01, (c + r) % 5 === 0 ? 0.001 : 0);
  const indices: number[] = [];
  for (let r = 0; r + 1 < rows; r += 1)
    for (let c = 0; c + 1 < columns; c += 1) {
      const a = r * columns + c;
      indices.push(a, a + 1, a + columns, a + 1, a + columns + 1, a + columns);
    }
  return { positions, indices };
}

/** A document whose implicit body entity is backed by `mesh` in an in-memory asset port. */
function assetDoc(mesh: { positions: number[]; indices: number[] }): { doc: CadDocument; id: string; port: MeshAssetPort } {
  const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
  const body = ok(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5 });
  const entity = body.doc.entities[body.id];
  if (entity?.kind !== 'mesh') throw new Error('mesh body expected');
  const ref = {
    key: 'k'.repeat(64),
    triangles: mesh.indices.length / 3,
    vertices: mesh.positions.length / 3,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  } as const;
  const port: MeshAssetPort = { manifest: () => null, readMesh: () => mesh, writeMesh: () => ref, readFile: () => null };
  return { doc: { ...body.doc, entities: { ...body.doc.entities, [body.id]: { ...entity, asset: ref } } }, id: body.id, port };
}

describe('export_3mf byte cap and malformed meshes (command level)', () => {
  it('maxBytes below the compressed size refuses with EXPORT_MESH_TOO_LARGE and leaves the document unchanged; without it the export succeeds', () => {
    const { doc, id, port } = assetDoc(gridMesh());
    const ctx = { ...defaultContext(), meshAssets: port };
    const refused = execute(doc, 'export_3mf', { entityIds: [id], maxBytes: 1000 }, ctx);
    expect(refused.error?.code).toBe('EXPORT_MESH_TOO_LARGE');
    expect(refused.document).toBe(doc);
    const written = execute(doc, 'export_3mf', { entityIds: [id] }, ctx);
    expect(written.error).toBeUndefined();
    expect((written.data as { triangleCount: number }).triangleCount).toBe(312_000);
  });

  it('a triangle naming a vertex that does not exist is refused with EXPORT_MESH_INVALID', () => {
    const mesh = gridMesh();
    mesh.indices[5] = mesh.positions.length / 3 + 5;
    const { doc, id, port } = assetDoc(mesh);
    const refused = execute(doc, 'export_3mf', { entityIds: [id] }, { ...defaultContext(), meshAssets: port });
    expect(refused.error?.code).toBe('EXPORT_MESH_INVALID');
    expect(refused.document).toBe(doc);
  });
});

describe('triangle accounting', () => {
  it('counts the triangles of a soup asset mesh (empty indices) from its positions', () => {
    const { doc, id, port } = assetDoc({ positions: new Array<number>(27).fill(0).map((_, n) => n), indices: [] });
    const collected = collectExportParts(doc, [id], port);
    expect(collected.parts[0]?.triangleCount).toBe(3);
  });

  it('keptIndices drops degenerate triangles and rejects an index outside the vertices', () => {
    expect(Array.from(keptIndices({ positions: new Array<number>(9).fill(0), indices: [0, 1, 2, 0, 0, 1] }))).toEqual([0, 1, 2]);
    expect(() => keptIndices({ positions: new Array<number>(9).fill(0), indices: [0, 1, 3] })).toThrow(ThreeMfInvalidMeshError);
    expect(() => keptIndices({ positions: new Array<number>(9).fill(0), indices: [0, 1, 1.5] })).toThrow(ThreeMfInvalidMeshError);
    expect(() => keptIndices({ positions: new Array<number>(9).fill(0), indices: [0, -1, 2] })).toThrow(ThreeMfInvalidMeshError);
  });

  it('manifold is computed on the written triangles, not on skipped degenerates', () => {
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1];
    const cube = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
    const built = buildThreeMf([
      { name: 'cube', color: '#336699', tris: [], indexed: { positions, indices: [...cube, 0, 0, 1], offset: [0, 0, 0], scale: 1 } },
    ]);
    expect(built.objects[0]).toMatchObject({ vertices: 8, triangles: 12, manifold: true });
  });
});

describe('beam counts near the cap', () => {
  it('writes the minimum length of 150000 beams without a spread of the whole list', () => {
    const nodes: Array<[number, number, number]> = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 3, 0],
    ];
    const beams = Array.from({ length: 150_000 }, (_, n) => ({
      a: n % 2,
      b: (n % 2) + 1,
      r1: 0.1,
      r2: 0.1,
      cap1: 'sphere' as const,
      cap2: 'butt' as const,
    }));
    const xml = latticeObjectXml(
      2,
      'lattice',
      0,
      { nodes, beams, radius: 0.1, ballRadius: null, clip: null, representation: null },
      { clip: null, representation: null },
    );
    expect(xml).toContain('minlength="0.5"');
    expect(xml.split('<b:beam ').length - 1).toBe(150_000);
  });
});
