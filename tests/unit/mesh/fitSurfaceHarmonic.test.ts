/** 07 MSH M6 leftovers (TECHNICAL_SPEC 13.23): the harmonic-map parameterisation of fit_surface_to_mesh: the map on its own, its refusals by name, the fallback, the command. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { type HarmonicMap, harmonicMap } from '@core/geometry/mesh/harmonicMap';
import { evaluateSurface, surfaceDerivatives } from '@core/lib/nurbs/surface';
import { type CadDocument, type NurbsSurfaceEntity, type Vec3 } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { docWithMeshes, gridMesh, icosphere, torus, type IndexedMesh } from '../../helpers/meshFixtures';

const allFaces = (mesh: IndexedMesh): number[] => Array.from({ length: mesh.indices.length / 3 }, (_, f) => f);
const mapOf = (mesh: IndexedMesh, faces = allFaces(mesh)): HarmonicMap => {
  const result = harmonicMap(mesh, faces);
  if ('code' in result) throw new Error(`${result.code}: ${result.message}`);
  return result;
};
const refusalOf = (mesh: IndexedMesh, faces = allFaces(mesh)): { code: string; message: string } => {
  const result = harmonicMap(mesh, faces);
  if (!('code' in result)) throw new Error('expected a refusal');
  return result;
};
/** Signed area of every parameter triangle (positive = counter-clockwise), computed here, independently of the map. */
const parameterAreas = (mesh: IndexedMesh, map: HarmonicMap): number[] =>
  allFaces(mesh).map((f) => {
    const [a, b, c] = [0, 1, 2].map((k) => map.uv.get(mesh.indices[3 * f + k] as number) as [number, number]) as [
      [number, number],
      [number, number],
      [number, number],
    ];
    return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  });

/** The upper hemisphere of an icosphere (the triangles whose corners all have z >= 0): a disk with the equator as its boundary. */
function hemisphere(level: number): IndexedMesh {
  const sphere = icosphere(10, level);
  const indices: number[] = [];
  for (let t = 0; t < sphere.indices.length; t += 3) {
    const corners = [0, 1, 2].map((k) => sphere.indices[t + k] as number);
    if (corners.every((v) => (sphere.positions[3 * v + 2] as number) > -1e-9)) indices.push(...corners);
  }
  return { positions: sphere.positions, indices };
}

/** A C-shaped, jittered, uneven grid (a slit from the right edge): a disk whose exact cotangent weights flip triangles. */
function cShape(seed: number): IndexedMesh {
  let state = seed;
  const random = (): number => ((state = (state * 1103515245 + 12345) % 2147483648), state / 2147483648);
  const n = 8;
  const positions: number[] = [];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) positions.push(i + (random() - 0.5) * 0.9 * (i % 2 ? 1 : 0.2), j * (0.2 + 0.8 * random()), 0);
  const id = (i: number, j: number): number => j * (n + 1) + i;
  const indices: number[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      if (i >= 2 && j >= 3 && j < 5) continue;
      indices.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
    }
  return { positions, indices };
}

describe('harmonicMap', () => {
  it('maps a square grid onto the unit square as the identity (a linear function is harmonic), with no flipped triangle', () => {
    const grid = gridMesh(10, 8);
    const map = mapOf(grid);
    expect(map.weights).toBe('cotangent');
    expect(map.flippedFirst).toBe(0);
    expect(map.boundaryVertices).toBe(32);
    expect(map.interiorVertices).toBe(49);
    let worst = 0;
    for (let v = 0; v < grid.positions.length / 3; v++) {
      const [u, w] = map.uv.get(v) as [number, number];
      worst = Math.max(
        worst,
        Math.abs(u - (grid.positions[3 * v] as number) / 10),
        Math.abs(w - (grid.positions[3 * v + 1] as number) / 10),
      );
    }
    expect(worst).toBeLessThan(1e-9);
    expect(map.cgResidual).toBeLessThan(1e-10);
    expect(parameterAreas(grid, map).every((area) => area > 0)).toBe(true);
  });

  it('puts the boundary of a hemisphere on the square by arc length, counter-clockwise, and every triangle keeps its orientation', () => {
    const mesh = hemisphere(4);
    const map = mapOf(mesh);
    expect(parameterAreas(mesh, map).every((area) => area >= -1e-12)).toBe(true);
    // boundary vertices lie on the square's sides; the equator is 64 equal chords: the shares of the perimeter go up by 1/64 each
    const onSide = [...map.uv.values()].filter(([u, v]) => u === 0 || u === 1 || v === 0 || v === 1);
    expect(onSide).toHaveLength(map.boundaryVertices);
    for (const [u, v] of map.uv.values()) {
      expect(u).toBeGreaterThanOrEqual(-1e-12);
      expect(u).toBeLessThanOrEqual(1 + 1e-12);
      expect(v).toBeGreaterThanOrEqual(-1e-12);
      expect(v).toBeLessThanOrEqual(1 + 1e-12);
    }
    const perimeter = (u: number, v: number): number => (v === 0 ? u : u === 1 ? 1 + v : v === 1 ? 3 - u : 4 - v);
    const shares = onSide.map(([u, v]) => perimeter(u, v)).sort((a, b) => a - b);
    const gaps = shares.slice(1).map((s, i) => s - (shares[i] as number));
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.2 * (4 / map.boundaryVertices));
    // the pole is inside the square, near its centre
    const pole = [...map.uv.entries()].reduce((best, [v, uv]) =>
      (mesh.positions[3 * v + 2] as number) > (mesh.positions[3 * best[0] + 2] as number) ? [v, uv] : best,
    );
    expect(Math.hypot(pole[1][0] - 0.5, pole[1][1] - 0.5)).toBeLessThan(0.1);
  });

  it('falls back to positive weights when the exact cotangent weights flip a triangle, and the result has no flipped triangle', () => {
    for (const seed of [1, 4, 10]) {
      const mesh = cShape(seed);
      const map = mapOf(mesh);
      expect(map.weights, `seed ${seed}`).toBe('cotangent_clamped');
      expect(map.flippedFirst).toBeGreaterThan(0);
      expect(parameterAreas(mesh, map).every((area) => area >= -1e-12)).toBe(true);
      expect(map.cgResidual).toBeLessThan(1e-10);
    }
  });

  it('refuses a region that is not a disk, naming why', () => {
    const grid = gridMesh(10, 6);
    const cells = (keep: (i: number, j: number) => boolean): number[] =>
      allFaces(grid).filter((f) => keep(Math.floor(f / 2) % 6, Math.floor(f / 2 / 6)));
    const ball = icosphere(1, 0);
    const withBall: IndexedMesh = {
      positions: [...grid.positions, ...ball.positions],
      indices: [...grid.indices, ...ball.indices.map((v) => v + grid.positions.length / 3)],
    };
    const cases: Array<[string, IndexedMesh, number[], RegExp]> = [
      ['a closed sphere', icosphere(10, 2), allFaces(icosphere(10, 2)), /closed \(it has no boundary loop\)/],
      ['a disk and a separate closed ball', withBall, allFaces(withBall), /several pieces/],
      ['an annulus', grid, cells((i, j) => !(i >= 2 && i < 4 && j >= 2 && j < 4)), /2 boundary loops \(holes\)/],
      ['two pieces', grid, cells((i) => i < 2 || i >= 4), /several pieces|2 boundary loops/],
      [
        'two triangles sharing one vertex (a pinch)',
        { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0], indices: [0, 1, 2, 0, 3, 4] },
        [0, 1],
        /touches itself at vertex 0/,
      ],
      [
        'a torus with one triangle removed (handles)',
        torus(10, 3, 12, 8),
        allFaces(torus(10, 3, 12, 8)).slice(1),
        /Euler characteristic -1 with one boundary loop/,
      ],
    ];
    for (const [label, mesh, faces, expected] of cases) {
      const refusal = refusalOf(mesh, faces);
      expect(refusal.code, label).toBe('MESH_FIT_NOT_DISK');
      expect(refusal.message, label).toMatch(expected);
    }
    // a face wound against its neighbours uses an edge twice in one direction
    const flipped = {
      positions: grid.positions,
      indices: grid.indices.map((v, i) => (i >= 3 && i < 6 ? (grid.indices[i === 3 ? 5 : i === 5 ? 3 : i] as number) : v)),
    };
    expect(refusalOf(flipped).message).toMatch(/consistently wound manifold/);
    expect(harmonicMap(grid, [])).toMatchObject({ code: 'MESH_FIT_NOT_DISK' });
  });
});

const idOf = (doc: CadDocument): string => doc.order[0] as string;
const surfaceOf = (doc: CadDocument, id: string): NurbsSurfaceEntity['surface'] => (doc.entities[id] as NurbsSurfaceEntity).surface;
const normalAt = (doc: CadDocument, id: string, u: number, v: number): Vec3 => {
  const d = surfaceDerivatives(surfaceOf(doc, id), u, v, 1);
  const [du, dv] = [(d[1] as Vec3[])[0] as Vec3, (d[0] as Vec3[])[1] as Vec3];
  return [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]];
};
type Data = Record<string, unknown>;
const dataOf = (result: { data?: unknown }): Data => result.data as Data;

describe('fit_surface_to_mesh parameterization', () => {
  const dome = docWithMeshes(hemisphere(4));
  const id = idOf(dome.doc);

  it('auto and harmonic fit a hemisphere (a disk that projection refuses): the patch lies on the sphere and its normal faces outward', () => {
    const projected = execute(dome.doc, 'fit_surface_to_mesh', { id, parameterization: 'projection', controlPoints: [20, 20] });
    expectNoOp(projected, dome.doc);
    expect(projected.error?.code).toBe('MESH_FIT_NOT_PROJECTABLE');
    for (const parameterization of [undefined, 'harmonic'] as const) {
      const result = execute(dome.doc, 'fit_surface_to_mesh', {
        id,
        controlPoints: [20, 20],
        ...(parameterization === undefined ? {} : { parameterization }),
      });
      expect(result.error, result.summary).toBeUndefined();
      const data = dataOf(result);
      expect(data['parameterization']).toMatchObject({ method: 'harmonic', weights: 'cotangent', flippedWithExactWeights: 0 });
      expect(data['frame']).toBeNull();
      expect(data['maxDeviation'] as number).toBeLessThan(0.2);
      const surface = surfaceOf(result.document, result.affected[0] as string);
      for (const [u, v] of [
        [0.5, 0.5],
        [0.3, 0.6],
        [0.7, 0.4],
      ] as const) {
        const p = evaluateSurface(surface, u, v);
        expect(Math.abs(Math.hypot(...p) - 10)).toBeLessThan(0.1);
        const normal = normalAt(result.document, result.affected[0] as string, u, v);
        expect(normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2]).toBeGreaterThan(0);
      }
    }
  });

  it('auto keeps projection for a projectable region (and says so), harmonic can be asked for explicitly on one', () => {
    const plate = docWithMeshes(gridMesh(20, 10));
    const plateId = idOf(plate.doc);
    const auto = execute(plate.doc, 'fit_surface_to_mesh', { id: plateId, controlPoints: [6, 6] });
    expect(dataOf(auto)['parameterization']).toEqual({ method: 'projection' });
    const harmonic = execute(plate.doc, 'fit_surface_to_mesh', { id: plateId, controlPoints: [6, 6], parameterization: 'harmonic' });
    expect(harmonic.error, harmonic.summary).toBeUndefined();
    expect(dataOf(harmonic)['maxDeviation'] as number).toBeLessThan(1e-6);
    const poles = surfaceOf(harmonic.document, harmonic.affected[0] as string).poles;
    expect(poles.every((row) => row.every((p) => Math.abs(p[2]) < 1e-9))).toBe(true);
    // the patch covers the whole plate and its normal is +z, like the triangles'
    expect(normalAt(harmonic.document, harmonic.affected[0] as string, 0.5, 0.5)[2]).toBeGreaterThan(0);
  });

  it('puts u along the long side of the region (a 5 x 20 plate: u would run along x, the short side): the first row of poles runs 20 long, the grid is 3 times denser along it', () => {
    const strip = docWithMeshes({
      positions: gridMesh(20, 20).positions.map((v, i) => (i % 3 === 0 ? v / 4 : v)),
      indices: gridMesh(20, 20).indices,
    });
    const result = execute(strip.doc, 'fit_surface_to_mesh', { id: idOf(strip.doc), parameterization: 'harmonic', maxDeviation: 0.5 });
    expect(result.error, result.summary).toBeUndefined();
    const [nu, nv] = dataOf(result)['controlPoints'] as [number, number];
    expect(nu).toBeGreaterThan(nv);
    const surface = surfaceOf(result.document, result.affected[0] as string);
    const [start, end] = [evaluateSurface(surface, 0, 0.5), evaluateSurface(surface, 1, 0.5)];
    expect(Math.hypot(end[0] - start[0], end[1] - start[1])).toBeGreaterThan(18);
    expect(Math.abs(normalAt(result.document, result.affected[0] as string, 0.5, 0.5)[2])).toBeGreaterThan(0);
    expect(normalAt(result.document, result.affected[0] as string, 0.5, 0.5)[2]).toBeGreaterThan(0);
  });

  it('refuses a region that is not a disk with the reason, by name: harmonic asked for a closed body, and auto on one that is also not projectable', () => {
    const ball = docWithMeshes(icosphere(10, 3));
    const ballId = idOf(ball.doc);
    const asked = execute(ball.doc, 'fit_surface_to_mesh', { id: ballId, parameterization: 'harmonic' });
    expectNoOp(asked, ball.doc);
    expect(asked.error?.code).toBe('MESH_FIT_NOT_DISK');
    expect(asked.summary).toContain('closed');
    const auto = execute(ball.doc, 'fit_surface_to_mesh', { id: ballId });
    expectNoOp(auto, ball.doc);
    expect(auto.error?.code).toBe('MESH_FIT_NOT_PROJECTABLE');
    expect(auto.summary).toContain('harmonic map needs a disk');
    expect(execute(ball.doc, 'fit_surface_to_mesh', { id: ballId, parameterization: 'spherical' }).error?.code).toBe('CMD_INVALID_PARAMS');
  });

  it('is pure and replays', () => {
    expectPure(dome.doc, () => execute(dome.doc, 'fit_surface_to_mesh', { id, controlPoints: [8, 8] }));
    const first = execute(dome.doc, 'fit_surface_to_mesh', { id, controlPoints: [8, 8] });
    const second = execute(dome.doc, 'fit_surface_to_mesh', { id, controlPoints: [8, 8] });
    expect(JSON.stringify(surfaceOf(first.document, first.affected[0] as string))).toBe(
      JSON.stringify(surfaceOf(second.document, second.affected[0] as string)),
    );
  });
});
