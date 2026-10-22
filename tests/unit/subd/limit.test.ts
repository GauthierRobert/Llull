import { describe, expect, it } from 'vitest';
import { boxCage, subdivide, type Cage } from '@core/geometry/subdivision';
import { cageVertexLimits, sampleCurvature, subdominantEigenvalue, surfaceEvaluator } from '@core/geometry/subd/limit';
import { cross3, len3, normalize3OrZero, sub3, add3 } from '@lib/vec3';
import type { Vec3 } from '@core/model/types';

const cube = boxCage([2, 2, 2], [1, 1, 1]);
const close = (actual: readonly number[] | undefined, expected: readonly number[], digits = 12): void =>
  expected.forEach((value, i) => expect((actual as readonly number[])[i], `component ${i}`).toBeCloseTo(value, digits));

describe('limit masks and eigenvalue (VC-DIR-01)', () => {
  it('matches the OpenSubdiv lambda for valence 3..12', () => {
    const expected = [
      [3, 0.410097050801],
      [4, 0.5],
      [5, 0.549988354518],
      [6, 0.579682326102],
      [7, 0.598510283482],
      [8, 0.611116526695],
      [9, 0.619939220626],
      [10, 0.626341267547],
      [11, 0.631127586683],
      [12, 0.634796412354],
    ] as const;
    for (const [n, lambda] of expected) expect(subdominantEigenvalue(n)).toBeCloseTo(lambda, 11);
  });
});

describe('cube limits (VC-DIR-02, 03)', () => {
  it('corner limit and normal', () => {
    const [corner] = cageVertexLimits(cube, [2]);
    close(corner?.point, [0.5, 0.5, 0.5]);
    close(corner?.normal, [0.57735026919, 0.57735026919, 0.57735026919], 11);
    expect(corner).toMatchObject({ rule: 'smooth', valence: 3 });
  });
  it('face centre and edge midpoint limits', () => {
    const evaluate = surfaceEvaluator(cube);
    close(evaluate(0, 0.5, 0.5)?.point, [0, 0, 68 / 81]);
    close(evaluate(0, 0.5, 1)?.point, [0, 395 / 648, 395 / 648]);
  });
  it('flags a sample at an extraordinary vertex as approximate and returns its limit point', () => {
    const sample = surfaceEvaluator(cube)(0, 0, 0);
    expect(sample?.approximate).toBe(true);
    close(sample?.point, [-0.5, -0.5, 0.5]);
    expect(sampleCurvature(sample as NonNullable<typeof sample>)).toBeNull();
  });
  it('reports curvature of a regular sample: positive on a convex shape', () => {
    const regular = surfaceEvaluator(subdivide(cube, 2))(0, 0.5, 0.5);
    const curvature = sampleCurvature(regular as NonNullable<typeof regular>);
    expect(curvature?.k1).toBeGreaterThan(0);
    expect(curvature?.k2).toBeGreaterThan(0);
    expect(curvature?.k1).toBeGreaterThanOrEqual(curvature?.k2 ?? 0);
    expect(len3(curvature?.normal as Vec3)).toBeCloseTo(1, 12);
    expect((curvature?.normal as Vec3)[2]).toBeGreaterThan(0);
  });
  it('refuses non-quad faces and out-of-range faces', () => {
    const cap = { vertices: cube.vertices, faces: [[0, 1, 2, 3, 4], ...cube.faces.slice(1)], creases: [] } satisfies Cage;
    expect(surfaceEvaluator(cap)(0, 0.5, 0.5)).toBeNull();
    expect(surfaceEvaluator(cube)(99, 0.5, 0.5)).toBeNull();
  });
  it('uses the crease and corner masks', () => {
    const edges = cube.faces.flatMap((face) => face.map((a, i): [number, number] => [a, face[(i + 1) % 4] as number]));
    const [corner] = cageVertexLimits({ ...cube, creases: edges }, [0]);
    expect(corner?.rule).toBe('corner');
    close(corner?.point, cube.vertices[0] as Vec3);
    close(corner?.normal, [-0.57735026919, -0.57735026919, 0.57735026919], 11);
    const [crease] = cageVertexLimits(
      {
        ...cube,
        creases: [
          [0, 1],
          [0, 3],
        ],
      },
      [0],
    );
    expect(crease?.rule).toBe('crease');
    close(crease?.point, [-2 / 3, -2 / 3, 1]);
  });
});

/** Regular torus cage (8 x 6 quads, R 3, r 1), outward wound. */
function torusCage(): Cage {
  const [nu, nv] = [8, 6];
  const vertices: Vec3[] = [];
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const [theta, phi] = [(2 * Math.PI * i) / nu, (2 * Math.PI * j) / nv];
      vertices.push([(3 + Math.cos(phi)) * Math.cos(theta), (3 + Math.cos(phi)) * Math.sin(theta), Math.sin(phi)]);
    }
  const at = (i: number, j: number): number => (i % nu) * nv + (j % nv);
  const faces = vertices.flatMap((_, k) => {
    const [i, j] = [Math.floor(k / nv), k % nv];
    return [[at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]];
  });
  return { vertices, faces, creases: [] };
}

describe('regular patches are uniform B-splines (VC-DIR-08 core part)', () => {
  const torus = torusCage();
  it('corners of every patch equal the vertex limit masks', () => {
    const evaluate = surfaceEvaluator(torus);
    const limits = cageVertexLimits(
      torus,
      torus.vertices.map((_, v) => v),
    );
    torus.faces.forEach((face, f) =>
      face.forEach((v, corner) => {
        const sample = evaluate(f, [0, 1, 1, 0][corner] as number, [0, 0, 1, 1][corner] as number);
        expect(sample?.depth).toBe(0);
        close(sample?.point, limits[v]?.point as Vec3, 12);
      }),
    );
  });
  it('patch centres agree with a deep subdivision and the surface normal points outward', () => {
    const deep = subdivide(torus, 4);
    const sample = surfaceEvaluator(torus)(0, 0.5, 0.5);
    const nearest = deep.vertices.reduce((best, p) =>
      len3(sub3(p, sample?.point as Vec3)) < len3(sub3(best, sample?.point as Vec3)) ? p : best,
    );
    expect(len3(sub3(nearest, sample?.point as Vec3))).toBeLessThan(0.05);
    const centre: Vec3 = [3 * Math.cos(0), 0, 0];
    expect(len3(sub3(sample?.point as Vec3, centre))).toBeGreaterThan(0.5);
  });
});

describe('extraordinary vertex of valence 5: tangent masks against deep subdivision', () => {
  /** Pentagonal bipyramid, apexes pushed sideways so no symmetry hides a wrong weight. */
  function bipyramid(): Cage {
    const ring: Vec3[] = Array.from({ length: 5 }, (_, k): Vec3 => {
      const angle = (2 * Math.PI * k) / 5;
      return [Math.cos(angle) * (1 + 0.1 * k), Math.sin(angle) * (1 - 0.05 * k), 0.1 * Math.sin(3 * angle)];
    });
    const vertices: Vec3[] = [[0.3, 0.2, 1.1], [-0.2, 0.1, -1], ...ring];
    const faces = Array.from({ length: 5 }, (_, k) => [
      [0, 2 + k, 2 + ((k + 1) % 5)],
      [1, 2 + ((k + 1) % 5), 2 + k],
    ]).flat();
    return { vertices, faces, creases: [] };
  }
  it('limit point and normal agree with level-6 refinement within 3e-3', () => {
    const cage = bipyramid();
    const [limit] = cageVertexLimits(cage, [0]);
    expect(limit?.valence).toBe(5);
    const deep = subdivide(cage, 6);
    const around = cage.faces.length > 0 ? deep.faces.filter((face) => face.includes(0)) : [];
    const normal = around.reduce<Vec3>(
      (sum, face) => {
        const [a, b, c] = face.slice(0, 3).map((v) => deep.vertices[v] as Vec3) as [Vec3, Vec3, Vec3];
        return add3(sum, cross3(sub3(b, a), sub3(c, a)));
      },
      [0, 0, 0],
    );
    close(deep.vertices[0], limit?.point as Vec3, 2);
    expect(len3(sub3(deep.vertices[0] as Vec3, limit?.point as Vec3))).toBeLessThan(3e-3);
    const cosine = normalize3OrZero(normal).reduce((s, value, i) => s + value * ((limit?.normal as Vec3)[i] as number), 0);
    expect(cosine).toBeGreaterThan(1 - 3e-3);
  });
});
