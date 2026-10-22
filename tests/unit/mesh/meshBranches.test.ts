/** 07 MSH: remaining branches of the TS engine, the readers and the report texts (scalar types of binary PLY, malformed 3MF attributes, summaries of damaged meshes). */

import { describe, expect, it } from 'vitest';
import { composeMeshEngines, resolveMeshEngine } from '@core/geometry/mesh/engine';
import { MESH_HULL_POINT_LIMIT } from '@core/geometry/mesh/engineTypes';
import { subdivideMesh } from '@core/geometry/mesh/subdivide';
import { execute } from '@core/commands/registry';
import { parseMeshFile } from '@lib/meshFormats';
import { isParseFailure } from '@lib/meshFormats/types';
import { zipStore } from '@lib/zip';
import { cuboid, docWithMeshes, icosphere, torus } from '../../helpers/meshFixtures';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const ts = resolveMeshEngine(null);

describe('TypeScript engine limits', () => {
  const box = cuboid([0, 0, 0], [1, 1, 1]);
  const ball = icosphere(1, 2);

  it('leaves non-convex operands, differences, level sets and smooth refinement to another engine', () => {
    const ring = torus(5, 2, 16, 8);
    expect(ts.run({ mesh: ring }, { op: 'minkowski', kind: 'sum', other: { mesh: box } })).toMatchObject({
      code: 'MESH_ENGINE_UNSUPPORTED',
    });
    const flat = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], indices: [0, 1, 2, 1, 3, 2] };
    expect(ts.run({ mesh: flat }, { op: 'minkowski', kind: 'sum', other: { mesh: box } })).toMatchObject({
      code: 'MESH_ENGINE_UNSUPPORTED',
    });
    expect(ts.run({ mesh: box }, { op: 'minkowski', kind: 'difference', other: { mesh: box } })).toMatchObject({
      code: 'MESH_ENGINE_UNSUPPORTED',
    });
    expect(ts.run({ mesh: box }, { op: 'offset', method: 'level_set', distance: 1, tolerance: 1, maxCells: 1 })).toMatchObject({
      code: 'MESH_ENGINE_UNSUPPORTED',
    });
    expect(ts.run({ mesh: box }, { op: 'subdivide', method: 'smooth', levels: 1, featureAngleDeg: 30 })).toMatchObject({
      code: 'MESH_ENGINE_UNSUPPORTED',
    });
  });

  it('hands very large vertex-sum products on and refuses hull inputs above the point limit', () => {
    const fine = icosphere(1, 4);
    expect(ts.run({ mesh: fine }, { op: 'minkowski', kind: 'sum', other: { mesh: fine } })).toMatchObject({
      code: 'MESH_ENGINE_UNSUPPORTED',
      message: expect.stringContaining('exceed'),
    });
    const points = new Array<number>((MESH_HULL_POINT_LIMIT + 1) * 3).fill(0);
    expect(composeMeshEngines([ts]).run({ mesh: { positions: [], indices: [] } }, { op: 'hull', points })).toMatchObject({
      code: 'MESH_ENGINE_CAP_EXCEEDED',
    });
    expect(ts.run({ mesh: { positions: [], indices: [] } }, { op: 'hull', points: [0, 0, 0, 1, 0, 0] })).toMatchObject({
      code: 'MESH_HULL_DEGENERATE',
    });
  });

  it('a flat sum is a degenerate hull and a normal offset skips degenerate faces', () => {
    const sheet = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };
    expect(ts.run({ mesh: ball }, { op: 'minkowski', kind: 'sum', other: { mesh: ball } })).toMatchObject({ mesh: expect.anything() });
    const withDegenerate = { positions: [...box.positions], indices: [...box.indices, 0, 0, 1] };
    const moved = ts.run({ mesh: withDegenerate }, { op: 'offset', method: 'normal', distance: 0.1, tolerance: 1, maxCells: 1 });
    expect(moved).toMatchObject({ report: { selfIntersectionsCreated: 0 } });
    expect(ts.run({ mesh: sheet }, { op: 'offset', method: 'normal', distance: 0.1, tolerance: 1, maxCells: 1 })).toMatchObject({
      mesh: expect.anything(),
    });
  });
});

describe('Loop subdivision valences', () => {
  it('uses the valence-3 weight on a tetrahedron', () => {
    const tetra = { positions: [1, 1, 1, 1, -1, -1, -1, 1, -1, -1, -1, 1], triangles: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] };
    const refined = subdivideMesh(tetra, 'loop', 1);
    expect(refined.triangles).toHaveLength(48);
    // vertex rule for n = 3: (1 - 3 x 3/16) v + 3/16 x (sum of the three neighbours); the corner (1,1,1) stays on the diagonal
    expect(refined.positions.slice(0, 3).every((value) => Math.abs(value - (refined.positions[0] as number)) < 1e-12)).toBe(true);
    expect(Math.abs(refined.positions[0] as number)).toBeLessThan(1);
  });
});

describe('report texts of damaged meshes', () => {
  it('analyze_mesh names open, non-manifold and badly oriented meshes in its summary', () => {
    const box = cuboid([0, 0, 0], [1, 1, 1]);
    const flipped = [...box.indices];
    [flipped[1], flipped[2]] = [flipped[2] as number, flipped[1] as number];
    const { doc, ids } = docWithMeshes(
      { positions: box.positions, indices: flipped },
      { positions: box.positions, indices: [...box.indices.slice(0, 33)] },
      { positions: box.positions, indices: [...box.indices, 0, 2, 3, 0, 3, 2] },
    );
    const mixed = execute(doc, 'analyze_mesh', { id: ids[0], selfIntersections: false });
    expect(mixed.summary).toContain('inconsistent orientation');
    expect(mixed.summary).not.toContain('crossing');
    const open = execute(doc, 'analyze_mesh', { id: ids[1] });
    expect(open.summary).toContain('open');
    expect(open.summary).not.toContain('volume');
    const thick = execute(doc, 'analyze_mesh', { id: ids[2] });
    expect(thick.summary).toContain('non-manifold edge');
  });
});

describe('binary PLY with every scalar type', () => {
  it('reads char / uchar / short / ushort / int / uint / float / double properties and ushort / uint index lists', () => {
    const head = text(
      'ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty double x\nproperty float y\nproperty double z\nproperty char a\nproperty uchar b\nproperty short c\nproperty ushort d\nproperty int e\nproperty uint f\n' +
        'element face 2\nproperty list ushort uint vertex_indices\nproperty list uchar ushort extra\nend_header\n',
    );
    const vertex = 8 + 4 + 8 + 1 + 1 + 2 + 2 + 4 + 4;
    const face = 2 + 3 * 4 + (1 + 1 * 2);
    const body = new DataView(new ArrayBuffer(3 * vertex + 2 * face));
    let at = 0;
    for (let v = 0; v < 3; v++) {
      body.setFloat64(at, v, true);
      body.setFloat32(at + 8, v * 2, true);
      body.setFloat64(at + 12, 0, true);
      body.setInt8(at + 20, -1);
      body.setUint8(at + 21, 200);
      body.setInt16(at + 22, -300, true);
      body.setUint16(at + 24, 60000, true);
      body.setInt32(at + 26, -70000, true);
      body.setUint32(at + 30, 4_000_000_000, true);
      at += vertex;
    }
    for (let f = 0; f < 2; f++) {
      body.setUint16(at, 3, true);
      [0, 1, 2].forEach((value, k) => body.setUint32(at + 2 + k * 4, value, true));
      body.setUint8(at + 14, 1);
      body.setUint16(at + 15, 7, true);
      at += face;
    }
    const bytes = new Uint8Array(head.length + body.byteLength);
    bytes.set(head, 0);
    bytes.set(new Uint8Array(body.buffer), head.length);
    const result = parseMeshFile(bytes, 'ply');
    if (isParseFailure(result)) throw new Error(result.message);
    expect(result.bodies[0]?.positions.slice(3, 6)).toEqual([1, 2, 0]);
    expect(result.bodies[0]?.triangles).toEqual([0, 1, 2, 0, 1, 2]);
    expect(result.dropped).toContain('face.extra');
    expect(result.dropped).toContain('vertex.f');
  });
});

describe('3MF attribute fallbacks', () => {
  const part = (build: string): Uint8Array =>
    zipStore([
      {
        name: '3D/3dmodel.model',
        data: text(
          `<model unit="meter"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object><object><components><component objectid="1" transform="1 2 3"/><component objectid="404"/><component/></components></object></resources><build>${build}</build></model>`,
        ),
      },
    ]);

  it('treats a malformed transform as the identity, skips unknown or missing references and reads the unit', () => {
    const result = parseMeshFile(part('<item objectid="1" transform="not twelve numbers"/><item/><item objectid="2"/>'), '3mf');
    if (isParseFailure(result)) throw new Error(result.message);
    expect(result.unitMetres).toBe(1);
    expect(result.bodies.length).toBeGreaterThanOrEqual(2);
    expect(result.bodies[0]?.positions.slice(3, 6)).toEqual([1, 0, 0]);
  });
});
