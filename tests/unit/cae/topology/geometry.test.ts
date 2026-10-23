/** Contours, Douglas-Peucker and the derived iso-surface on synthetic fields (TR-TOP-08/09). */
import { describe, expect, it } from 'vitest';
import type { FeTopologyArtifact, SymmetryPlane } from '@core/model/topology';
import type { MeshData } from '@core/model/types';
import { contourLoops, marchingSquares, nodeGridOfVoxels, simplifyLoop, type Point } from '@cae/topology/contours';
import { deriveTopologyMesh, symmetrise } from '@cae/topology/derive';

const signedArea = (loop: readonly Point[]): number =>
  loop.reduce((sum, p, i) => sum + (p[0] * (loop[(i + 1) % loop.length]?.[1] ?? 0) - (loop[(i + 1) % loop.length]?.[0] ?? 0) * p[1]), 0) /
  2;

/** Voxel field from a predicate on voxel indices, x fastest. */
const fieldOf = (nx: number, ny: number, nz: number, solid: (i: number, j: number, k: number) => boolean): Float32Array =>
  Float32Array.from({ length: nx * ny * nz }, (_, index) => {
    const i = index % nx;
    const j = Math.floor(index / nx) % ny;
    return solid(i, j, Math.floor(index / (nx * ny))) ? 1 : 0;
  });

describe('nodeGridOfVoxels', () => {
  it('averages the adjacent voxels with zeros outside the grid and a ring of zero nodes around', () => {
    const grid = nodeGridOfVoxels([1, 1, 1, 1], 2, 2);
    expect([grid.cols, grid.rows, grid.padding]).toEqual([5, 5, 1]);
    const inner = [0, 1, 2].flatMap((j) => [0, 1, 2].map((i) => grid.values[i + 1 + 5 * (j + 1)]));
    expect(inner).toEqual([0.25, 0.5, 0.25, 0.5, 1, 0.5, 0.25, 0.5, 0.25]);
    expect(grid.values[0]).toBe(0);
  });
});

describe('marchingSquares', () => {
  it('traces an outer boundary counter-clockwise and a hole clockwise', () => {
    const field = fieldOf(8, 8, 1, (i, j) => i >= 1 && i <= 6 && j >= 1 && j <= 6 && !(i >= 3 && i <= 4 && j >= 3 && j <= 4));
    const loops = marchingSquares(nodeGridOfVoxels(field, 8, 8), 0.5);
    expect(loops).toHaveLength(2);
    const areas = loops.map(signedArea).sort((a, b) => a - b);
    expect(areas[0]).toBeLessThan(0);
    expect(areas[1]).toBeGreaterThan(0);
    expect(Math.abs((areas[0] ?? 0) / (areas[1] ?? 1))).toBeLessThan(0.2);
    expect(Math.abs(areas[1] ?? 0)).toBeGreaterThan(25);
  });

  it('is deterministic and finds nothing without a crossing', () => {
    const field = fieldOf(6, 6, 1, (i, j) => i > 1 && i < 5 && j > 1 && j < 5);
    const grid = nodeGridOfVoxels(field, 6, 6);
    expect(JSON.stringify(marchingSquares(grid, 0.5))).toBe(JSON.stringify(marchingSquares(grid, 0.5)));
    expect(marchingSquares(grid, 2)).toEqual([]);
    expect(marchingSquares(nodeGridOfVoxels(new Float32Array(16), 4, 4), 0.5)).toEqual([]);
  });

  it('closes every loop in each of the 16 corner cases (all single-cell patterns inside a padded grid)', () => {
    for (let pattern = 1; pattern < 16; pattern += 1) {
      const nodes = new Float64Array(16);
      const cell = [5, 6, 10, 9];
      cell.forEach((node, bit) => {
        nodes[node] = pattern & (1 << bit) ? 1 : 0;
      });
      const loops = marchingSquares({ cols: 4, rows: 4, values: nodes }, 0.5);
      expect(loops.length).toBeGreaterThan(0);
      for (const loop of loops) expect(loop.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('resolves a saddle by the cell mean: connected diagonal or two separate loops', () => {
    const nodes = new Float64Array(16);
    nodes[5] = 1;
    nodes[10] = 1;
    expect(marchingSquares({ cols: 4, rows: 4, values: nodes }, 0.4)).toHaveLength(1);
    expect(marchingSquares({ cols: 4, rows: 4, values: nodes }, 0.6)).toHaveLength(2);
    const other = new Float64Array(16);
    other[6] = 1;
    other[9] = 1;
    expect(marchingSquares({ cols: 4, rows: 4, values: other }, 0.4)).toHaveLength(1);
    expect(marchingSquares({ cols: 4, rows: 4, values: other }, 0.6)).toHaveLength(2);
  });
});

describe('simplifyLoop (Douglas-Peucker)', () => {
  const circle: Point[] = Array.from(
    { length: 200 },
    (_, i): Point => [10 * Math.cos((2 * Math.PI * i) / 200), 10 * Math.sin((2 * Math.PI * i) / 200)],
  );
  const distanceToLoop = (p: Point, loop: readonly Point[]): number =>
    Math.min(
      ...loop.map((a, i) => {
        const b = loop[(i + 1) % loop.length] as Point;
        const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
      }),
    );

  it('keeps every dropped point within the tolerance of the result', () => {
    for (const tolerance of [0.01, 0.05, 0.3]) {
      const simplified = simplifyLoop(circle, tolerance);
      expect(simplified.length).toBeLessThan(circle.length);
      expect(simplified.length).toBeGreaterThanOrEqual(3);
      for (const point of circle) expect(distanceToLoop(point, simplified)).toBeLessThanOrEqual(tolerance + 1e-12);
    }
  });

  it('drops collinear points and leaves short loops and a zero tolerance alone', () => {
    const square: Point[] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [3, 3],
      [0, 3],
    ];
    expect(simplifyLoop(square, 0.01)).toHaveLength(4);
    expect(simplifyLoop(circle, 0)).toHaveLength(200);
    expect(
      simplifyLoop(
        [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        5,
      ),
    ).toHaveLength(3);
    const sliver: Point[] = [
      [0, 0],
      [10, 0],
      [10, 0.001],
      [0, 0.001],
    ];
    expect(simplifyLoop(sliver, 5)).toEqual(sliver);
  });
});

describe('contourLoops', () => {
  const field = fieldOf(12, 12, 1, (i, j) => (i >= 2 && i <= 9 && j >= 2 && j <= 9) || (i === 11 && j === 0));
  const grid = nodeGridOfVoxels(field, 12, 12);

  it('scales and shifts the loops into document units and drops small loops, counting them', () => {
    const all = contourLoops(grid, 0.25, { origin: [100, 50], scale: 2 }, 0.01, 0);
    expect(all.contours.length).toBe(2);
    expect(all.dropped).toBe(0);
    const big = contourLoops(grid, 0.25, { origin: [100, 50], scale: 2 }, 0.01, 5);
    expect(big.contours).toHaveLength(1);
    expect(big.dropped).toBe(1);
    const outer = big.contours[0];
    expect(outer?.area).toBeGreaterThan(200);
    for (const point of outer?.points ?? []) {
      expect(point[0]).toBeGreaterThanOrEqual(100 + 2 * 1.5);
      expect(point[1]).toBeLessThanOrEqual(50 + 2 * 10.5);
    }
  });
});

const artifactOf = (
  nx: number,
  ny: number,
  nz: number,
  plane?: SymmetryPlane,
  voxel = 1,
  origin: [number, number, number] = [0, 0, 0],
): FeTopologyArtifact => ({
  kind: 'fe_topology',
  inputHash: 'i',
  settingsHash: 's',
  grid: {
    nx,
    ny,
    nz,
    active: nx * ny * nz,
    keepIn: 0,
    keepOut: 0,
    dimension: plane === undefined ? 3 : 2,
    ...(plane === undefined ? {} : { plane }),
    voxel,
    origin,
    thickness: plane === undefined ? voxel : 2,
  },
  xPhys: '',
  compliance: 1,
  perLoadCase: {},
  iterations: 1,
  status: 'converged',
  history: [],
  solver: { job: 'topopt', version: 't', device: 'cpu', deterministic: true },
});

/** Divergence-theorem volume, and whether every directed edge has its reverse exactly once (closed, consistently oriented surface). */
function volumeAndClosure(mesh: MeshData): { volume: number; closed: boolean } {
  const p = (index: number): number[] => [
    mesh.positions[3 * index] ?? 0,
    mesh.positions[3 * index + 1] ?? 0,
    mesh.positions[3 * index + 2] ?? 0,
  ];
  let volume = 0;
  const edges = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t] ?? 0, mesh.indices[t + 1] ?? 0, mesh.indices[t + 2] ?? 0];
    const [pa, pb, pc] = [p(a), p(b), p(c)];
    volume +=
      ((pa[0] ?? 0) * ((pb[1] ?? 0) * (pc[2] ?? 0) - (pb[2] ?? 0) * (pc[1] ?? 0)) -
        (pa[1] ?? 0) * ((pb[0] ?? 0) * (pc[2] ?? 0) - (pb[2] ?? 0) * (pc[0] ?? 0)) +
        (pa[2] ?? 0) * ((pb[0] ?? 0) * (pc[1] ?? 0) - (pb[1] ?? 0) * (pc[0] ?? 0))) /
      6;
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const)
      edges.set(`${from}>${to}`, (edges.get(`${from}>${to}`) ?? 0) + 1);
  }
  const closed = [...edges.entries()].every(([key, count]) => {
    const [from, to] = key.split('>');
    return count === 1 && edges.get(`${to}>${from}`) === 1;
  });
  return { volume, closed };
}

describe('deriveTopologyMesh', () => {
  it('extrudes a 2D contour into a closed, outward-oriented solid of the thresholded area', () => {
    const field = fieldOf(10, 8, 1, (i, j) => i >= 2 && i <= 7 && j >= 1 && j <= 6);
    const mesh = deriveTopologyMesh(artifactOf(10, 8, 1, 'XY', 1, [5, 6, 7]), field, 0.5, []);
    const { volume, closed } = volumeAndClosure(mesh);
    expect(closed).toBe(true);
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(volume).toBeGreaterThan(0);
    expect(volume).toBeGreaterThan(30 * 2);
    expect(volume).toBeLessThan(36 * 2);
    expect(Math.min(...mesh.positions.filter((_, i) => i % 3 === 2))).toBe(7);
    expect(Math.max(...mesh.positions.filter((_, i) => i % 3 === 2))).toBe(9);
  });

  it('keeps holes: the solid with a hole is lighter, still closed and oriented', () => {
    const solid = fieldOf(12, 12, 1, (i, j) => i >= 1 && i <= 10 && j >= 1 && j <= 10);
    const holed = fieldOf(12, 12, 1, (i, j) => i >= 1 && i <= 10 && j >= 1 && j <= 10 && !(i >= 4 && i <= 7 && j >= 4 && j <= 7));
    const artifact = artifactOf(12, 12, 1, 'XY');
    const full = volumeAndClosure(deriveTopologyMesh(artifact, solid, 0.5, []));
    const withHole = volumeAndClosure(deriveTopologyMesh(artifact, holed, 0.5, []));
    expect(withHole.closed).toBe(true);
    expect(withHole.volume).toBeGreaterThan(0);
    expect(withHole.volume).toBeLessThan(full.volume - 20);
  });

  it.each<SymmetryPlane>(['XZ', 'YZ'])('orients the winding outward on the %s plane (axes permuted)', (plane) => {
    const field = fieldOf(8, 6, 1, (i, j) => i >= 1 && i <= 6 && j >= 1 && j <= 4);
    const { volume, closed } = volumeAndClosure(deriveTopologyMesh(artifactOf(8, 6, 1, plane), field, 0.5, []));
    expect(closed).toBe(true);
    expect(volume).toBeGreaterThan(20);
  });

  it('marching tetrahedra: a 3D block gives a closed, welded, outward-oriented surface of about its volume', () => {
    const field = fieldOf(8, 8, 8, (i, j, k) => i >= 2 && i <= 5 && j >= 2 && j <= 5 && k >= 2 && k <= 5);
    const artifact = artifactOf(8, 8, 8);
    const mesh = deriveTopologyMesh(artifact, field, 0.5, []);
    const { volume, closed } = volumeAndClosure(mesh);
    expect(closed).toBe(true);
    expect(volume).toBeGreaterThan(40);
    expect(volume).toBeLessThan(80);
    expect(JSON.stringify(deriveTopologyMesh(artifact, field, 0.5, []))).toBe(JSON.stringify(mesh));
    expect(new Set(mesh.indices).size).toBe(mesh.positions.length / 3);
  });

  it('a block whose node values hit the threshold has no zero-area triangles and no coincident vertices', () => {
    const field = fieldOf(6, 6, 6, (i, j, k) => i >= 2 && i <= 3 && j >= 2 && j <= 3 && k >= 2 && k <= 3);
    const mesh = deriveTopologyMesh(artifactOf(6, 6, 6), field, 0.5, []);
    const key = (v: number): string => [0, 1, 2].map((a) => (mesh.positions[3 * v + a] ?? 0).toFixed(9)).join(',');
    expect(new Set(Array.from({ length: mesh.positions.length / 3 }, (_, v) => key(v))).size).toBe(mesh.positions.length / 3);
    for (let tri = 0; tri < mesh.indices.length; tri += 3) {
      const [a, b, c] = [mesh.indices[tri] ?? 0, mesh.indices[tri + 1] ?? 0, mesh.indices[tri + 2] ?? 0];
      const p = (v: number, axis: number): number => mesh.positions[3 * v + axis] ?? 0;
      const u = [0, 1, 2].map((axis) => p(b, axis) - p(a, axis));
      const w = [0, 1, 2].map((axis) => p(c, axis) - p(a, axis));
      const cross = Math.hypot(
        (u[1] ?? 0) * (w[2] ?? 0) - (u[2] ?? 0) * (w[1] ?? 0),
        (u[2] ?? 0) * (w[0] ?? 0) - (u[0] ?? 0) * (w[2] ?? 0),
        (u[0] ?? 0) * (w[1] ?? 0) - (u[1] ?? 0) * (w[0] ?? 0),
      );
      expect(cross).toBeGreaterThan(1e-9);
    }
    expect(volumeAndClosure(mesh).closed).toBe(true);
  });

  it('closes the surface of a field that fills the grid up to its border', () => {
    const flat = volumeAndClosure(deriveTopologyMesh(artifactOf(4, 4, 1, 'XY'), new Float32Array(16).fill(1), 0.5, []));
    expect(flat.closed).toBe(true);
    expect(flat.volume).toBeGreaterThan(20);
    const block = volumeAndClosure(deriveTopologyMesh(artifactOf(3, 3, 3), new Float32Array(27).fill(1), 0.5, []));
    expect(block.closed).toBe(true);
    expect(block.volume).toBeGreaterThan(15);
  });

  it('is empty when no voxel reaches the threshold and mirrors across symmetry planes', () => {
    expect(deriveTopologyMesh(artifactOf(4, 4, 4), new Float32Array(64), 0.5, []).indices).toEqual([]);
    expect(deriveTopologyMesh(artifactOf(6, 4, 1, 'XY'), new Float32Array(24), 0.5, ['YZ']).indices).toEqual([]);
    const half = fieldOf(8, 4, 1, (i) => i < 3);
    const artifact = artifactOf(8, 4, 1, 'XY');
    const mirrored = symmetrise(half, artifact.grid, ['YZ']);
    expect(Array.from(mirrored.slice(0, 8))).toEqual([0.5, 0.5, 0.5, 0, 0, 0.5, 0.5, 0.5]);
    expect(symmetrise(half, artifact.grid, ['XY'])).toBe(half);
    const solid = deriveTopologyMesh(artifact, half, 0.9, ['YZ']);
    expect(solid.indices).toEqual([]);
    const cube = fieldOf(6, 6, 6, (i) => i < 3);
    const sym3 = symmetrise(cube, artifactOf(6, 6, 6).grid, ['YZ', 'XZ', 'XY', 'XY']);
    expect(sym3[0]).toBeCloseTo(0.125 * 4, 6);
  });
});
