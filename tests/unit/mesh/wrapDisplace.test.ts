/** `shrinkwrap_mesh` and `displace_mesh` (07 MSH FR-MSH-38 / FR-MSH-39, VC-MSH-38 / VC-MSH-39, TECHNICAL_SPEC 13.18). */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { MESH_TS_TRIANGLE_CAP } from '@core/geometry/mesh/engineTypes';
import { SurfaceIndex } from '@core/geometry/mesh/surfaceIndex';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import { displaceMesh as displaceMeshGeometry } from '@core/geometry/mesh/wrapDisplace';
import type { CadDocument, MeshSolidEntity } from '@core/model/types';
import { uint8ArrayToBase64 } from '@lib/base64';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { type IndexedMesh, docWithMeshes, gridMesh, icosphere } from '../../helpers/meshFixtures';

type Result = ReturnType<typeof execute>;
const meshOf = (result: Result, id = result.affected[0] as string): MeshSolidEntity['mesh'] =>
  (result.document.entities[id] as MeshSolidEntity).mesh;
const dataOf = (result: Result): Record<string, unknown> => result.data as Record<string, unknown>;
const distanceToMesh = (vertices: ReadonlyArray<number>, target: IndexedMesh): number => {
  const index = new SurfaceIndex(target.positions, target.indices);
  let worst = 0;
  for (let v = 0; v < vertices.length; v += 3)
    worst = Math.max(worst, index.closest([vertices[v] as number, vertices[v + 1] as number, vertices[v + 2] as number]).distance);
  return worst;
};
/** z of the vertex at (x, y). */
const zAt = (mesh: { positions: ReadonlyArray<number> }, x: number, y: number): number => {
  for (let v = 0; v < mesh.positions.length; v += 3)
    if (Math.abs((mesh.positions[v] as number) - x) < 1e-9 && Math.abs((mesh.positions[v + 1] as number) - y) < 1e-9)
      return mesh.positions[v + 2] as number;
  throw new Error(`no vertex at ${x}, ${y}`);
};
const radii = (mesh: { positions: ReadonlyArray<number> }): number[] =>
  Array.from({ length: mesh.positions.length / 3 }, (_, v) =>
    Math.hypot(mesh.positions[3 * v] as number, mesh.positions[3 * v + 1] as number, mesh.positions[3 * v + 2] as number),
  );

/** A flat grid [0, size]^2 at height z, wound +z, as an indexed mesh. */
const gridAt = (size: number, n: number, z: number): IndexedMesh => {
  const grid = gridMesh(size, n);
  return { positions: grid.positions.map((v, i) => (i % 3 === 2 ? z : v)), indices: grid.indices };
};

describe('shrinkwrap_mesh', () => {
  const source = icosphere(12, 3);
  const target = icosphere(10, 4);
  const { doc, ids } = docWithMeshes(source, target);
  const [id, targetId] = ids as [string, string];

  it('VC-MSH-38: an icosphere R12 wrapped onto an icosphere R10 lies on it (distance 0 within 1e-12), connectivity unchanged', () => {
    const result = execute(doc, 'shrinkwrap_mesh', { id, targetId });
    expect(result.error, result.summary).toBeUndefined();
    expect(result.affected).toEqual([id]);
    const wrapped = meshOf(result);
    expect(wrapped.indices.length).toBe((doc.entities[id] as MeshSolidEntity).mesh.indices.length);
    expect(distanceToMesh(wrapped.positions, target)).toBeLessThanOrEqual(1e-12);
    const data = dataOf(result);
    expect(data).toMatchObject({ targetId, mode: 'nearest', missed: 0, moved: wrapped.positions.length / 3 });
    expect(data['residual'] as number).toBeLessThanOrEqual(1e-12);
    expect(data['maxMove'] as number).toBeGreaterThan(1.9);
    expect(Math.max(...radii(wrapped))).toBeLessThanOrEqual(10 + 1e-9);
    expect(result.document.entities[targetId]).toBe(doc.entities[targetId]);
    expect(result.summary).toContain("shrinkwrap_mesh '");
  });

  it('keeps an offset from the target on the chosen side (along the face normal: a facet edge makes the distance a little less than the offset, residual under 2 %)', () => {
    const outside = execute(doc, 'shrinkwrap_mesh', { id, targetId, offset: 1, side: 'outside' });
    expect(dataOf(outside)['residual'] as number).toBeLessThan(0.02);
    expect(Math.min(...radii(meshOf(outside)))).toBeGreaterThan(10);
    const inside = execute(doc, 'shrinkwrap_mesh', { id, targetId, offset: 1, side: 'inside' });
    expect(dataOf(inside)['residual'] as number).toBeLessThan(0.02);
    expect(Math.max(...radii(meshOf(inside)))).toBeLessThan(10);
    // a vertex that was inside stays inside with "keep" (the default)
    const small = docWithMeshes(icosphere(8, 3), target);
    const kept = execute(small.doc, 'shrinkwrap_mesh', { id: small.ids[0] as string, targetId: small.ids[1] as string, offset: 1 });
    expect(Math.max(...radii(meshOf(kept)))).toBeLessThan(10);
    expect(dataOf(kept)['residual'] as number).toBeLessThan(0.02);
  });

  it('keepSource adds the wrapped copy and leaves the source untouched', () => {
    const result = execute(doc, 'shrinkwrap_mesh', { id, targetId, keepSource: true });
    expect(result.affected).toHaveLength(1);
    expect(result.affected[0]).not.toBe(id);
    expect(result.document.entities[id]).toBe(doc.entities[id]);
  });

  it('normal and direction modes cast rays (both ways, nearest hit); a ray that misses leaves the vertex and counts it', () => {
    const flat = docWithMeshes(gridMesh(10, 8), gridAt(40, 8, -3));
    const [a, b] = flat.ids as [string, string];
    // the vertex normals of the grid are +z: the plane below is hit backwards
    const byNormal = execute(flat.doc, 'shrinkwrap_mesh', { id: a, targetId: b, mode: 'normal' });
    expect(byNormal.error, byNormal.summary).toBeUndefined();
    expect(
      meshOf(byNormal)
        .positions.filter((_, i) => i % 3 === 2)
        .every((z) => Math.abs(z + 3) < 1e-12),
    ).toBe(true);
    expect(dataOf(byNormal)).toMatchObject({ missed: 0, mode: 'normal' });
    // the same along an oblique direction: x and y shift by the slope
    const oblique = execute(flat.doc, 'shrinkwrap_mesh', { id: a, targetId: b, mode: 'direction', direction: [-1, 0, 3] });
    const moved = meshOf(oblique);
    const before = (flat.doc.entities[a] as MeshSolidEntity).mesh;
    expect(moved.positions[0]).toBeCloseTo((before.positions[0] as number) + 1, 12);
    expect(moved.positions[2]).toBeCloseTo(-3, 12);
    // a direction parallel to the plane never hits it
    const parallel = execute(flat.doc, 'shrinkwrap_mesh', { id: a, targetId: b, mode: 'direction', direction: [1, 0, 0] });
    expect(dataOf(parallel)).toMatchObject({ moved: 0, missed: 81 });
    expect(
      meshOf(parallel)
        .positions.filter((_, i) => i % 3 === 2)
        .every((z) => z === 0),
    ).toBe(true);
    expect(before.positions.length).toBeGreaterThan(0);
  });

  it('hits the target in both directions: the nearer hit wins, forward or backward', () => {
    const planes = (above: number, below: number): IndexedMesh => {
      const [a, b] = [gridAt(40, 4, above), gridAt(40, 4, below)];
      return { positions: [...a.positions, ...b.positions], indices: [...a.indices, ...b.indices.map((i) => i + a.positions.length / 3)] };
    };
    for (const [above, below, expected] of [
      [1, -3, 1],
      [3, -1, -1],
    ] as const) {
      const both = docWithMeshes(gridMesh(10, 4), planes(above, below));
      const result = execute(both.doc, 'shrinkwrap_mesh', { id: both.ids[0] as string, targetId: both.ids[1] as string, mode: 'normal' });
      expect(result.error, result.summary).toBeUndefined();
      expect(
        meshOf(result)
          .positions.filter((_, i) => i % 3 === 2)
          .every((z) => Math.abs(z - expected) < 1e-12),
      ).toBe(true);
      const along = execute(both.doc, 'shrinkwrap_mesh', {
        id: both.ids[0] as string,
        targetId: both.ids[1] as string,
        mode: 'direction',
        direction: [0, 0, 2],
      });
      expect(
        meshOf(along)
          .positions.filter((_, i) => i % 3 === 2)
          .every((z) => Math.abs(z - expected) < 1e-12),
      ).toBe(true);
    }
  });

  it('maxDistance leaves the vertices farther than it from the target in place', () => {
    const flat = docWithMeshes(gridMesh(10, 8), gridAt(40, 8, -3));
    const [a, b] = flat.ids as [string, string];
    const refused = execute(flat.doc, 'shrinkwrap_mesh', { id: a, targetId: b, maxDistance: 2 });
    expect(dataOf(refused)).toMatchObject({ moved: 0, missed: 81 });
    const reached = execute(flat.doc, 'shrinkwrap_mesh', { id: a, targetId: b, maxDistance: 3 });
    expect(dataOf(reached)).toMatchObject({ moved: 81, missed: 0 });
    const ray = execute(flat.doc, 'shrinkwrap_mesh', { id: a, targetId: b, mode: 'normal', maxDistance: 2.9 });
    expect(dataOf(ray)).toMatchObject({ moved: 0, missed: 81 });
  });

  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'shrinkwrap_mesh', { id, targetId, mode: 'normal' }));
  });

  it('refuses by name and returns the document unchanged: unknown ids, the target the source itself, a missing or empty direction, a non-solid target, a target over the cap', () => {
    const cases: Array<[Record<string, unknown>, string, string?]> = [
      [{ id: 'nope', targetId }, 'MESH_ENTITY_NOT_FOUND'],
      [{ id, targetId: 'nope' }, 'MESH_ENTITY_NOT_FOUND', 'targetId'],
      [{ id, targetId: id }, 'MESH_PARAM_INVALID', 'targetId'],
      [{ id, targetId, mode: 'direction' }, 'MESH_PARAM_INVALID', 'direction'],
      [{ id, targetId, mode: 'direction', direction: [0, 0, 0] }, 'MESH_PARAM_INVALID', 'direction'],
    ];
    for (const [params, code, path] of cases) {
      const result = execute(doc, 'shrinkwrap_mesh', params);
      expect(result.error?.code, JSON.stringify(params)).toBe(code);
      if (path !== undefined) expect(JSON.stringify(result.error) + result.summary).toContain(path);
      expectNoOp(result, doc);
    }
    const line = execute(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 0],
      ],
    });
    const lineId = line.affected[0] as string;
    const notSolid = execute(line.document, 'shrinkwrap_mesh', { id, targetId: lineId });
    expect(notSolid.error?.code).toBe('MESH_NOT_A_MESH');
    const big = docWithMeshes(gridMesh(10, 8), gridMesh(10, 330));
    const capped = execute(big.doc, 'shrinkwrap_mesh', { id: big.ids[0] as string, targetId: big.ids[1] as string });
    expect(MESH_TS_TRIANGLE_CAP).toBeLessThan(330 * 330 * 2);
    expect(capped.error?.code).toBe('MESH_ENGINE_CAP_EXCEEDED');
    expectNoOp(capped, big.doc);
  });
});

describe('SurfaceIndex.ray', () => {
  it('returns the first hit of a ray, the lower triangle on a tie, and null past tMax or beside the mesh', () => {
    const grid = gridAt(10, 4, 0);
    const index = new SurfaceIndex(grid.positions, grid.indices);
    expect(index.ray([2.5, 2.5, 5], [0, 0, -1], Infinity)).toMatchObject({ distance: 5 });
    expect(index.ray([2.5, 2.5, 5], [0, 0, -1], 4.9)).toBeNull();
    expect(index.ray([2.5, 2.5, 5], [0, 0, 1], Infinity)).toBeNull();
    expect(index.ray([20, 2.5, 5], [0, 0, -1], Infinity)).toBeNull();
    // a ray along a shared edge hits both triangles at the same distance: the lower index
    const one = gridAt(10, 1, 0); // two triangles sharing the diagonal (0, 0) - (10, 10)
    expect(new SurfaceIndex(one.positions, one.indices).ray([5, 5, 5], [0, 0, -1], Infinity)).toEqual({ distance: 5, face: 0 });
    const stacked = new SurfaceIndex(
      [...grid.positions, ...grid.positions.map((v, i) => (i % 3 === 2 ? 1 : v))],
      [...grid.indices, ...grid.indices.map((i) => i + grid.positions.length / 3)],
    );
    expect(stacked.ray([2.5, 2.5, 5], [0, 0, -1], Infinity)).toMatchObject({ distance: 4 });
  });
});

describe('displace_mesh', () => {
  const grid = gridMesh(20, 20);
  const { doc, ids } = docWithMeshes(grid);
  const id = ids[0] as string;

  it('VC-MSH-39: a grid of 20 x 20 displaced by 0.5 sweeps 200 (relative 1e-12) and moves every vertex 0.5 along +z', () => {
    const result = execute(doc, 'displace_mesh', { id, expression: '0.5' });
    expect(result.error, result.summary).toBeUndefined();
    const data = dataOf(result);
    expect(Math.abs((data['displacedVolume'] as number) - 200) / 200).toBeLessThanOrEqual(1e-12);
    expect(data).toMatchObject({ volumeBasis: 'height-field-sum', movedVertices: 441, maxDisplacement: 0.5, refinedEdges: 0 });
    expect(
      meshOf(result)
        .positions.filter((_, i) => i % 3 === 2)
        .every((z) => z === 0.5),
    ).toBe(true);
    expect(meshOf(result).indices.length).toBe((doc.entities[id] as MeshSolidEntity).mesh.indices.length);
    expect((data['deviation'] as { hausdorff: number }).hausdorff).toBeCloseTo(0.5, 9);
  });

  it('the expression sees x, y, z and the normal; strength scales it; a fixed direction replaces the normal', () => {
    const wave = execute(doc, 'displace_mesh', { id, expression: 'sin(x / 20 * pi)', strength: 2 });
    const mesh = meshOf(wave);
    expect(zAt(mesh, 10, 0)).toBeCloseTo(2 * Math.sin((10 / 20) * Math.PI), 12);
    expect(zAt(mesh, 5, 0)).toBeCloseTo(2 * Math.sin((5 / 20) * Math.PI), 12);
    const nz = execute(doc, 'displace_mesh', { id, expression: 'nz + 0 * ny + 0 * nx' });
    expect(zAt(meshOf(nz), 4, 4)).toBeCloseTo(1, 12);
    const sideways = execute(doc, 'displace_mesh', { id, expression: '1', direction: [3, 0, 4] });
    const moved = meshOf(sideways);
    const origin = Array.from({ length: moved.positions.length / 3 }, (_, v) => v).find(
      (v) => Math.abs((moved.positions[3 * v] as number) - 0.6) < 1e-9 && Math.abs((moved.positions[3 * v + 2] as number) - 0.8) < 1e-9,
    );
    expect(origin).toBeDefined();
  });

  it('a closed mesh reports the volume difference: a sphere inflated by 0.1 along its normals', () => {
    const ball = docWithMeshes(icosphere(10, 3));
    const result = execute(ball.doc, 'displace_mesh', { id: ball.ids[0] as string, expression: '0.1' });
    const data = dataOf(result);
    expect(data['volumeBasis']).toBe('closed-volume-difference');
    // 4 pi r^2 dr for the sphere the icosphere approximates (the mesh is a little under it)
    expect(data['displacedVolume'] as number).toBeGreaterThan(0.9 * 4 * Math.PI * 100 * 0.1);
    expect(data['displacedVolume'] as number).toBeLessThan(1.05 * 4 * Math.PI * 100 * 0.1);
    // and it is exactly the difference of the two enclosed volumes (the height-field sum would differ in the third digit)
    const volume = (mesh: { positions: ReadonlyArray<number>; indices: ReadonlyArray<number> }): number => {
      let sum = 0;
      for (let f = 0; f < mesh.indices.length; f += 3) {
        const at = (k: number): number[] => {
          const o = (mesh.indices[f + k] as number) * 3;
          return [mesh.positions[o] as number, mesh.positions[o + 1] as number, mesh.positions[o + 2] as number];
        };
        const [p, q, r] = [at(0), at(1), at(2)] as [number[], number[], number[]];
        const [qxr0, qxr1, qxr2] = [
          (q[1] as number) * (r[2] as number) - (q[2] as number) * (r[1] as number),
          (q[2] as number) * (r[0] as number) - (q[0] as number) * (r[2] as number),
          (q[0] as number) * (r[1] as number) - (q[1] as number) * (r[0] as number),
        ];
        sum += ((p[0] as number) * qxr0 + (p[1] as number) * qxr1 + (p[2] as number) * qxr2) / 6;
      }
      return sum;
    };
    const before = (ball.doc.entities[ball.ids[0] as string] as MeshSolidEntity).mesh;
    expect(data['displacedVolume'] as number).toBeCloseTo(volume(meshOf(result)) - volume(before), 9);
  });

  it('a height map displaces by grey / 255 - midlevel, bilinear between pixel centres, 0 outside its rectangle', () => {
    const pixels = uint8ArrayToBase64(Uint8Array.from([0, 255, 0, 255]));
    const map = {
      pixels,
      width: 2,
      height: 2,
      plane: 'xy' as const,
      origin: [0, 0] as [number, number],
      size: [10, 10] as [number, number],
    };
    const result = execute(doc, 'displace_mesh', { id, heightMap: map, midlevel: 0 });
    const mesh = meshOf(result);
    // grey is 0 up to the centre of the first pixel column (x = 2.5), 1 from the second (x = 7.5), linear between; the rectangle ends at x = 10
    expect(zAt(mesh, 0, 0)).toBe(0);
    expect(zAt(mesh, 2, 5)).toBeCloseTo(0, 12);
    expect(zAt(mesh, 5, 5)).toBeCloseTo(0.5, 12);
    expect(zAt(mesh, 8, 5)).toBeCloseTo(1, 12);
    expect(zAt(mesh, 10, 5)).toBeCloseTo(1, 12);
    expect(zAt(mesh, 12, 5)).toBe(0);
    expect(zAt(mesh, 5, 12)).toBe(0);
    const centred = execute(doc, 'displace_mesh', { id, heightMap: map });
    expect(zAt(meshOf(centred), 5, 5)).toBeCloseTo(0, 12);
    expect(zAt(meshOf(centred), 8, 5)).toBeCloseTo(0.5, 12);
    expect(zAt(meshOf(centred), 12, 5)).toBe(0);
  });

  it('refineEdge splits the long edges first so the surface follows the field', () => {
    const coarse = docWithMeshes(gridMesh(10, 2));
    const result = execute(coarse.doc, 'displace_mesh', { id: coarse.ids[0] as string, expression: 'x', refineEdge: 1.5 });
    expect(result.error, result.summary).toBeUndefined();
    expect(dataOf(result)['refinedEdges'] as number).toBeGreaterThan(0);
    expect(meshOf(result).indices.length).toBeGreaterThan(8 * 3);
    const longest = (positions: ReadonlyArray<number>, indices: ReadonlyArray<number>): number => {
      let worst = 0;
      for (let t = 0; t < indices.length; t += 3)
        for (let k = 0; k < 3; k++) {
          const [p, q] = [(indices[t + k] as number) * 3, (indices[t + ((k + 1) % 3)] as number) * 3];
          worst = Math.max(
            worst,
            Math.hypot((positions[p] as number) - (positions[q] as number), (positions[p + 1] as number) - (positions[q + 1] as number)),
          );
        }
      return worst;
    };
    expect(longest(meshOf(result).positions, meshOf(result).indices)).toBeLessThanOrEqual(1.5 + 1e-9);
  });

  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'displace_mesh', { id, expression: '1', refineEdge: 5 }));
  });

  it('refuses by name and returns the document unchanged', () => {
    const map = { pixels: uint8ArrayToBase64(Uint8Array.from([1, 2, 3])), width: 2, height: 2, plane: 'xy', origin: [0, 0], size: [1, 1] };
    const cases: Array<[Record<string, unknown>, string, string?]> = [
      [{ id: 'nope', expression: '1' }, 'MESH_ENTITY_NOT_FOUND'],
      [{ id }, 'MESH_PARAM_INVALID', 'expression'],
      [{ id, expression: '1', heightMap: map }, 'MESH_PARAM_INVALID', 'expression'],
      [{ id, expression: '1 +' }, 'MESH_PARAM_INVALID', 'expression'],
      [{ id, expression: '1', direction: [0, 0, 0] }, 'MESH_PARAM_INVALID', 'direction'],
      [{ id, heightMap: { ...map, width: 3000, height: 3000 } }, 'MESH_PARAM_INVALID', 'heightMap'],
      [{ id, heightMap: map }, 'MESH_PARAM_INVALID', 'heightMap.pixels'],
      [{ id, expression: 'x ^ 2' }, 'MESH_PARAM_INVALID', 'expression'],
      [{ id, expression: 'unknown_name' }, 'MESH_PARAM_INVALID', 'x, y, z, nx, ny, nz, pi, tau'],
      [{ id, expression: '1 + '.repeat(2000) + '1' }, 'MESH_PARAM_INVALID', 'at most 4096'],
      [{ id, expression: '('.repeat(1000) + '1' + ')'.repeat(1000) }, 'MESH_PARAM_INVALID', 'expression'],
      [{ id, expression: '10', strength: 1e308 }, 'MESH_DISPLACE_FIELD', 'not a finite'],
      [{ id, expression: '1 / x' }, 'MESH_DISPLACE_FIELD'],
    ];
    for (const [params, code, path] of cases) {
      const result = execute(doc, 'displace_mesh', params);
      expect(result.error?.code, JSON.stringify(params)).toBe(code);
      if (path !== undefined) expect(JSON.stringify(result.error) + result.summary).toContain(path);
      expectNoOp(result, doc);
    }
    const sphere = docWithMeshes(icosphere(1, 1));
    const cap: CadDocument = sphere.doc;
    expect(execute(cap, 'displace_mesh', { id: sphere.ids[0] as string, expression: '1' }).error).toBeUndefined();
  });

  it('a height map whose pixel count is not width x height is refused by the geometry too (MESH_DISPLACE_FIELD), and a non-finite displacement names its vertex', () => {
    const mesh = { positions: grid.positions, indices: grid.indices };
    const base = { strength: 1, midlevel: 0.5, direction: 'normal' as const };
    const map = {
      pixels: uint8ArrayToBase64(Uint8Array.from([1, 2, 3])),
      width: 2,
      height: 2,
      plane: 'xy' as const,
      origin: [0, 0] as [number, number],
      size: [1, 1] as [number, number],
    };
    expect(tsMeshEngine.run({ mesh }, { op: 'displace', ...base, heightMap: map })).toMatchObject({ code: 'MESH_DISPLACE_FIELD' });
    expect(tsMeshEngine.run({ mesh }, { op: 'displace', ...base, strength: 1e308, expression: '10' })).toMatchObject({
      code: 'MESH_DISPLACE_FIELD',
      message: expect.stringContaining('vertex 0'),
    });
  });

  it('refineEdge past the triangle limit is MESH_DISPLACE_RESULT_TOO_LARGE (the geometry and the engine)', () => {
    const mesh = { positions: grid.positions, indices: grid.indices };
    const params = { expression: '1', strength: 1, midlevel: 0.5, direction: 'normal' as const, refineEdge: 0.1, maxTriangles: 2000 };
    expect(displaceMeshGeometry(mesh, params)).toMatchObject({ tooLarge: expect.any(Number) });
    const outcome = tsMeshEngine.run({ mesh }, { op: 'displace', ...params });
    expect(outcome).toMatchObject({ code: 'MESH_DISPLACE_RESULT_TOO_LARGE' });
  });
});
