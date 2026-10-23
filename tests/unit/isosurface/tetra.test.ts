/** lib/isosurface (05 IMP TR-IMP-08): convergence (VC-IMP-20/21) and the F6 regressions (exact edge keys, node-exact zeros, midpoint orientation). */
import { describe, expect, it } from 'vitest';
import { isClosedManifold, meshMeasures } from '@lib/isosurface/measures';
import { type IsoGrid, MAX_ISO_NODES, marchingTetrahedra } from '@lib/isosurface/tetra';

/** Signed-distance grid of `f` over [-half, half]^3 with spacing near `h`. */
function gridOf(f: (x: number, y: number, z: number) => number, half: number, h: number): IsoGrid {
  const cells = Math.ceil((2 * half) / h);
  const voxel = (2 * half) / cells;
  const n = cells + 1;
  const values = new Float64Array(n * n * n);
  for (let k = 0; k < n; k += 1)
    for (let j = 0; j < n; j += 1)
      for (let i = 0; i < n; i += 1) values[i + n * (j + n * k)] = f(-half + i * voxel, -half + j * voxel, -half + k * voxel);
  return { nodes: [n, n, n], origin: [-half, -half, -half], voxel, values, threshold: 0, insideAbove: false };
}

const sphere = (r: number) => (x: number, y: number, z: number) => Math.hypot(x, y, z) - r;
const torus = (big: number, small: number) => (x: number, y: number, z: number) => Math.hypot(Math.hypot(x, y) - big, z) - small;

describe('marchingTetrahedra', () => {
  it.each([1, 0.5, 0.25])('sphere R10 at h=%f: closed manifold, volume error within 0.6 (h/R)^2 (VC-IMP-20)', (h) => {
    const grid = gridOf(sphere(10), 11.3, h);
    const mesh = marchingTetrahedra(grid);
    expect(mesh).not.toBeNull();
    const measures = meshMeasures(mesh!);
    const exact = (4 / 3) * Math.PI * 1000;
    expect(isClosedManifold(mesh!)).toBe(true);
    expect(Math.abs(measures.volume - exact) / exact).toBeLessThanOrEqual(0.6 * (grid.voxel / 10) ** 2);
    expect(measures.volume).toBeLessThan(exact);
  });

  it.each([1, 0.5])('torus 5/2 at h=%f: closed manifold, error within 0.2 (h/r)^2 (VC-IMP-21)', (h) => {
    const grid = gridOf(torus(5, 2), 8, h);
    const mesh = marchingTetrahedra(grid)!;
    const exact = 2 * Math.PI ** 2 * 5 * 4;
    expect(isClosedManifold(mesh)).toBe(true);
    expect(Math.abs(meshMeasures(mesh).volume - exact) / exact).toBeLessThanOrEqual(0.2 * (grid.voxel / 2) ** 2);
  });

  it('F6: stays closed and exactly keyed on a grid of more than 2e6 nodes', () => {
    const mesh = marchingTetrahedra(gridOf(sphere(6), 7, 0.1))!;
    expect(mesh.positions.length / 3).toBeGreaterThan(40000);
    expect(isClosedManifold(mesh)).toBe(true);
    expect(meshMeasures(mesh).volume).toBeGreaterThan(0);
  });

  it('F6: node-exact zero values neither break closure nor flip a triangle', () => {
    const grid = gridOf((x, y, z) => Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) - 3, 5, 1);
    const mesh = marchingTetrahedra(grid)!;
    expect(isClosedManifold(mesh)).toBe(true);
    expect(meshMeasures(mesh).volume).toBeGreaterThan(0);
  });

  it('is deterministic and refuses grids whose edge keys would not be exact', () => {
    const grid = gridOf(sphere(3), 4, 0.5);
    expect(JSON.stringify(marchingTetrahedra(grid))).toBe(JSON.stringify(marchingTetrahedra(grid)));
    const huge: IsoGrid = { ...grid, nodes: [MAX_ISO_NODES, 2, 2] };
    expect(marchingTetrahedra(huge)).toBeNull();
    expect(marchingTetrahedra({ ...grid, nodes: [1, 4, 4] })).toEqual({ positions: [], indices: [] });
  });

  it('density mode (insideAbove) puts material where the value reaches the threshold', () => {
    const n = 6;
    const values = Float64Array.from({ length: n ** 3 }, (_, id) => {
      const [i, j, k] = [id % n, Math.floor(id / n) % n, Math.floor(id / n ** 2)];
      return i >= 2 && i <= 3 && j >= 2 && j <= 3 && k >= 2 && k <= 3 ? 1 : 0;
    });
    const mesh = marchingTetrahedra({ nodes: [n, n, n], origin: [0, 0, 0], voxel: 1, values, threshold: 0.5, insideAbove: true })!;
    expect(isClosedManifold(mesh)).toBe(true);
    expect(meshMeasures(mesh).volume).toBeGreaterThan(0);
  });
});

describe('isClosedManifold', () => {
  it('rejects an open mesh, a duplicated triangle and a mesh with a bad index count', () => {
    const open = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };
    expect(isClosedManifold(open)).toBe(false);
    expect(isClosedManifold({ ...open, indices: [0, 1] })).toBe(false);
    const tetra = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2] };
    expect(isClosedManifold(tetra)).toBe(true);
    expect(isClosedManifold({ ...tetra, indices: [...tetra.indices, 0, 2, 1] })).toBe(false);
  });
});
