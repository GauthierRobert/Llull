/** Euclidean feature transform, thickness on the medial set, marching squares and overhang (05 IMP 5.8, FR-IMP-32, 44; thickness accuracy +-2 voxels). */
import { describe, expect, it } from 'vitest';
import { contourLoops } from '@implicit/contour';
import { phaseThickness } from '@implicit/edt';
import { overhang } from '@implicit/overhang';

const grid = (n: number, h: number, inside: (x: number, y: number, z: number) => boolean): Uint8Array => {
  const out = new Uint8Array(n * n * n);
  for (let k = 0; k < n; k += 1)
    for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) out[i + n * (j + n * k)] = inside(i * h, j * h, k * h) ? 1 : 0;
  return out;
};

describe('phaseThickness', () => {
  const n = 96;
  const h = 0.25;
  const c = 12;

  it('reads a plate, a tube wall, a spherical shell and a solid cube within 2.5 voxels', () => {
    const plate = phaseThickness(
      grid(n, h, (x, y, z) => Math.abs(z - c) < 1 && Math.abs(x - c) < 8 && Math.abs(y - c) < 8),
      [n, n, n],
      h,
    );
    expect(plate.min).toBeCloseTo(1.75, 9);
    expect(plate.max).toBeCloseTo(1.75, 9);
    const tube = phaseThickness(
      grid(n, h, (x, y) => Math.hypot(x - c, y - c) < 3 && Math.hypot(x - c, y - c) > 2),
      [n, n, n],
      h,
    );
    expect(Math.abs((tube.min as number) - 1)).toBeLessThanOrEqual(2 * h);
    const shell = phaseThickness(
      grid(n, h, (x, y, z) => {
        const r = Math.hypot(x - c, y - c, z - c);
        return r < 10 && r > 8;
      }),
      [n, n, n],
      h,
    );
    expect(Math.abs((shell.min as number) - 2)).toBeLessThanOrEqual(2.5 * h);
    expect(Math.abs((shell.max as number) - 2)).toBeLessThanOrEqual(2.5 * h);
    const cube = phaseThickness(
      grid(n, h, (x, y, z) => Math.abs(x - c) < 5 && Math.abs(y - c) < 5 && Math.abs(z - c) < 5),
      [n, n, n],
      h,
    );
    expect(Math.abs((cube.min as number) - 10)).toBeLessThanOrEqual(2 * h);
    expect(shell.thicknesses.length).toBe(shell.medialNodes);
    expect(shell.minNode).not.toBeNull();
  });

  it('a window restricts the nodes read; a phase with no outside, or a wall of one or two nodes, has no resolved thickness', () => {
    const full = new Uint8Array(16 * 16 * 16).fill(1);
    expect(phaseThickness(full, [16, 16, 16], 1)).toMatchObject({ min: null, max: null, minNode: null, medialNodes: 0 });
    const thin = phaseThickness(
      grid(32, 0.25, (x, y, z) => Math.abs(z - 4.125) < 0.2 && Math.abs(x - 4) < 3 && Math.abs(y - 4) < 3),
      [32, 32, 32],
      0.25,
    );
    expect(thin.min).toBeNull();
    const plate = grid(48, 0.25, (x, y, z) => Math.abs(z - 6) < 1 && Math.abs(x - 6) < 5 && Math.abs(y - 6) < 5);
    const all = phaseThickness(plate, [48, 48, 48], 0.25);
    const corner = phaseThickness(plate, [48, 48, 48], 0.25, { lo: [0, 0, 0], hi: [10, 10, 48] });
    expect(corner.medialNodes).toBeLessThan(all.medialNodes);
  });

  it('measures a pore as the thickness of the complement', () => {
    const solid = grid(64, 0.25, (x, y, z) => !(Math.abs(z - 8) < 1 && Math.abs(x - 8) < 6 && Math.abs(y - 8) < 6));
    const gap = Uint8Array.from(solid, (v) => (v === 1 ? 0 : 1));
    const stats = phaseThickness(gap, [64, 64, 64], 0.25);
    expect(Math.abs((stats.min as number) - 1.75)).toBeLessThanOrEqual(0.5);
  });
});

describe('contourLoops', () => {
  const values = (n: number, f: (i: number, j: number) => number): Float64Array => {
    const out = new Float64Array(n * n);
    for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) out[i + n * j] = f(i, j);
    return out;
  };

  it('closes a single node, a block, a disc and a ring (exact zeros included) with oriented areas', () => {
    expect(
      contourLoops(
        values(5, (i, j) => (i === 2 && j === 2 ? -1 : 1)),
        5,
        5,
        1,
        [0, 0],
      ).map((l) => l.area),
    ).toEqual([0.5]);
    const block = contourLoops(
      values(6, (i, j) => (i >= 2 && i <= 3 && j >= 2 && j <= 3 ? -1 : 1)),
      6,
      6,
      1,
      [0, 0],
    );
    expect(block).toHaveLength(1);
    expect(block[0]?.area).toBe(3.5);
    const ring = contourLoops(
      values(301, (i, j) => {
        const r = Math.hypot((i - 150) * 0.08, (j - 150) * 0.08);
        return Math.max(r - 10, -(r - 6));
      }),
      301,
      301,
      0.08,
      [-12, -12],
    );
    expect(ring.map((l) => Math.round(l.area))).toEqual([314, -113]);
    expect(ring[0]?.perimeter).toBeCloseTo(2 * Math.PI * 10, 1);
  });

  it('resolves saddle cells by the value at the cell centre in both ways and returns nothing for a field without a sign change', () => {
    // a checkerboard: the diagonal corners are inside; the centre average decides whether they are joined
    const joined = contourLoops(
      values(3, (i, j) => ((i + j) % 2 === 0 ? -1 : 0.5)),
      3,
      3,
      1,
      [0, 0],
    );
    const separate = contourLoops(
      values(3, (i, j) => ((i + j) % 2 === 0 ? -0.1 : 5)),
      3,
      3,
      1,
      [0, 0],
    );
    expect(joined.length).toBeGreaterThan(0);
    expect(separate.length).toBeGreaterThan(joined.length);
    expect(
      contourLoops(
        values(4, () => 1),
        4,
        4,
        1,
        [0, 0],
      ),
    ).toEqual([]);
  });
});

describe('overhang', () => {
  /** A closed outward cube [0,1]^3 as 12 triangles. */
  const cube = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1],
    indices: [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5],
  };

  it('counts the downward faces flatter than the critical angle', () => {
    const flat = overhang(cube, [0, 0, 1], 45);
    expect(flat.area).toBeCloseTo(1, 12);
    expect(flat.totalArea).toBeCloseTo(6, 12);
    expect(flat.fraction).toBeCloseTo(1 / 6, 12);
    expect(flat.centroid).toEqual([0.5, 0.5, 0]);
    expect(flat.flattestDeg).toBeCloseTo(0, 6);
    expect(overhang(cube, [0, 0, 1], 0.5).area).toBeCloseTo(1, 12);
    expect(overhang(cube, [1, 0, 0], 45).area).toBeCloseTo(1, 12);
    expect(overhang({ positions: [0, 0, 0, 0, 0, 0, 0, 0, 0], indices: [0, 1, 2] }, [0, 0, 1], 45)).toMatchObject({
      area: 0,
      centroid: null,
      flattestDeg: null,
    });
  });
});
