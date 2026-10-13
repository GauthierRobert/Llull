import { describe, it, expect } from 'vitest';
import type { Vec3 } from '@core/model/types';
import { type Cage, boxCage, cylinderCage, subdivide } from '@core/geometry/subdivision';
import { patchPoint, quadCagePatches, subdivisionPatches } from '@core/geometry/subdivisionPatches';

/** Regular torus cage: every vertex has four smooth edges, so patches are exactly the limit. */
function torusCage(around: number, tube: number): Cage {
  const vertices: Vec3[] = [];
  for (let i = 0; i < around; i++) {
    for (let j = 0; j < tube; j++) {
      const [a, b] = [(2 * Math.PI * i) / around, (2 * Math.PI * j) / tube];
      const r = 3 + Math.cos(b);
      vertices.push([r * Math.cos(a), r * Math.sin(a), Math.sin(b)]);
    }
  }
  const at = (i: number, j: number): number => (i % around) * tube + (j % tube);
  const faces: number[][] = [];
  for (let i = 0; i < around; i++) {
    for (let j = 0; j < tube; j++) faces.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
  }
  return { vertices, faces, creases: [] };
}

const near = (a: Vec3, b: Vec3, digits = 9): void => a.forEach((value, axis) => expect(value).toBeCloseTo(b[axis] as number, digits));

describe('subdivision Bézier patches', () => {
  it('reproduces the uniform bicubic B-spline exactly on a regular cage', () => {
    const [around, tube] = [8, 6];
    const cage = torusCage(around, tube);
    const patches = quadCagePatches(cage);
    expect(patches).toHaveLength(48);
    const basis = (t: number): number[] => [
      (1 - t) ** 3 / 6,
      (3 * t ** 3 - 6 * t ** 2 + 4) / 6,
      (-3 * t ** 3 + 3 * t ** 2 + 3 * t + 1) / 6,
      t ** 3 / 6,
    ];
    const vertex = (i: number, j: number): Vec3 =>
      cage.vertices[(((i % around) + around) % around) * tube + (((j % tube) + tube) % tube)] as Vec3;
    patches.forEach((poles, f) => {
      const [i, j] = [Math.floor(f / tube), f % tube];
      for (const [u, v] of [
        [0, 0],
        [0.5, 0.5],
        [0.2, 0.7],
        [1, 0.4],
      ] as const) {
        const expected = [0, 1, 2, 3].reduce<Vec3>(
          (sum, a) =>
            [0, 1, 2, 3].reduce<Vec3>((inner, b) => {
              const weight = (basis(u)[a] as number) * (basis(v)[b] as number);
              const p = vertex(i - 1 + a, j - 1 + b);
              return [inner[0] + weight * p[0], inner[1] + weight * p[1], inner[2] + weight * p[2]];
            }, sum),
          [0, 0, 0],
        );
        near(patchPoint(poles, u, v), expected);
      }
    });
  });

  it('puts corners on the limit surface around extraordinary vertices too', () => {
    const cage = boxCage([2, 2, 2], [1, 1, 1]);
    const refined = subdivide(cage, 1);
    const patches = subdivisionPatches(cage);
    expect(patches).toHaveLength(24);
    const deep = subdivide(refined, 5).vertices;
    refined.faces.forEach((face, f) => near(patchPoint(patches[f] as Vec3[], 0, 0), deep[face[0] as number] as Vec3, 2));
  });

  it('shares boundary curves exactly between neighbours (watertight)', () => {
    const patches = subdivisionPatches(cylinderCage(1, 2, 5, 2));
    const key = (p: Vec3): string => p.join(',');
    const edges = new Map<string, number>();
    for (const poles of patches) {
      const rows = [0, 1, 2, 3];
      for (const curve of [
        rows.map((j) => poles[j] as Vec3),
        rows.map((j) => poles[12 + j] as Vec3),
        rows.map((i) => poles[i * 4] as Vec3),
        rows.map((i) => poles[i * 4 + 3] as Vec3),
      ]) {
        const forward = curve.map(key).join('|');
        const backward = [...curve].reverse().map(key).join('|');
        const id = forward < backward ? forward : backward;
        edges.set(id, (edges.get(id) ?? 0) + 1);
      }
    }
    expect([...edges.values()].every((count) => count === 2)).toBe(true);
  });

  it('follows crease curves and pins crease corners', () => {
    const cage = boxCage([2, 2, 2], [1, 1, 1]);
    const all = new Map<string, [number, number]>();
    for (const face of cage.faces)
      face.forEach((a, i) => {
        const b = face[(i + 1) % 4] as number;
        all.set(a < b ? `${a}:${b}` : `${b}:${a}`, [a, b]);
      });
    const patches = subdivisionPatches({ ...cage, creases: [...all.values()] });
    for (const poles of patches) {
      for (const [u, v] of [
        [0, 0],
        [0.3, 0.6],
        [1, 0.5],
      ] as const) {
        expect(Math.max(...patchPoint(poles, u, v).map(Math.abs))).toBeCloseTo(1, 9);
      }
    }
  });
});
