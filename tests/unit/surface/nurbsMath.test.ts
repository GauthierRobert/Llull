import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@core/model/types';
import type { NurbsCurveData } from '@lib/nurbs/types';
import { basisDerivatives, basisFunctions, findSpan } from '@lib/nurbs/basis';
import { clampedUniformKnots, compressKnots, expandKnots, nurbsViolation } from '@lib/nurbs/knotVector';
import { curveDerivatives, curveDomain, evaluateCurve, sampleCurve } from '@lib/nurbs/evaluate';
import { elevateDegree, insertKnot, movePole, reverseCurve, setWeight } from '@lib/nurbs/edit';
import { interpolatePoints } from '@lib/nurbs/interpolate';
import { conicCurve, conicRho, conicWeight, isCollinear, rhoFromShoulder, tangentApex } from '@lib/nurbs/conic';
import { curvatureAt, curveLength, planeNormalOf } from '@lib/nurbs/curvature';
import { solveBanded } from '@lib/nurbs/bandSolve';
import { curveDisplayPoints, poleExtent, scaleCurve } from '@core/geometry/nurbsCurve';
import conicCases from '../../../docs/aerospace/02-advanced-surfacing/validation/data/conic_cases.json';

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const curveOf = (degree: number, poles: Vec3[], weights?: number[]): NurbsCurveData => {
  const layout = clampedUniformKnots(poles.length, degree);
  return { degree, poles, ...(weights === undefined ? {} : { weights }), ...layout };
};
/** Largest distance between two curves over a parameter grid. */
const deviation = (a: NurbsCurveData, b: NurbsCurveData, steps = 200): number => {
  const [first, last] = curveDomain(a);
  let worst = 0;
  for (let i = 0; i <= steps; i++) {
    const u = first + ((last - first) * i) / steps;
    worst = Math.max(worst, distance(evaluateCurve(a, u), evaluateCurve(b, u)));
  }
  return worst;
};
/** Deterministic pseudo-random sequence in [0, 1). */
const random = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
};
const randomPoles = (count: number, seed: number): Vec3[] => {
  const next = random(seed);
  return Array.from({ length: count }, (): Vec3 => [next() * 10, next() * 10, next() * 10]);
};

describe('basis functions and knot vectors', () => {
  it('basis functions form a partition of unity and derivatives sum to 0', () => {
    const full = expandKnots([0, 0.3, 0.7, 1], [4, 1, 2, 4]);
    for (let i = 0; i <= 20; i++) {
      const u = i / 20;
      const span = findSpan(full.length - 4, 3, u, full);
      expect(basisFunctions(span, u, 3, full).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 14);
      const ders = basisDerivatives(span, u, 3, 3, full);
      expect(ders[0]!.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      for (const k of [1, 2, 3]) expect(ders[k]!.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 9);
    }
  });

  it('compress and expand knots round-trip; clamped uniform defaults', () => {
    const full = [0, 0, 0, 0.5, 0.5, 1, 1, 1];
    const { knots, multiplicities } = compressKnots(full);
    expect(knots).toEqual([0, 0.5, 1]);
    expect(multiplicities).toEqual([3, 2, 3]);
    expect(expandKnots(knots, multiplicities)).toEqual(full);
    expect(clampedUniformKnots(5, 2)).toEqual({ knots: [0, 1 / 3, 2 / 3, 1], multiplicities: [3, 1, 1, 3] });
  });

  it('reports the first violated rule with a param path', () => {
    const good = curveOf(2, randomPoles(5, 1));
    expect(nurbsViolation(good)).toBeNull();
    expect(nurbsViolation({ ...good, degree: 0 })?.path).toBe('degree');
    expect(nurbsViolation({ ...good, degree: 26 })?.path).toBe('degree');
    expect(nurbsViolation({ ...good, poles: good.poles.slice(0, 2) })?.path).toBe('poles');
    expect(nurbsViolation({ ...good, poles: [[Number.NaN, 0, 0], ...good.poles.slice(1)] })?.path).toBe('poles.0');
    expect(nurbsViolation({ ...good, weights: [1, 1] })?.path).toBe('weights');
    expect(nurbsViolation({ ...good, weights: [1, 1, 0, 1, 1] })?.path).toBe('weights.2');
    expect(nurbsViolation({ ...good, knots: [0, 1] })?.path).toBe('knots');
    expect(nurbsViolation({ ...good, knots: [0, 0.5, 0.5, 1] })?.path).toBe('knots');
    expect(nurbsViolation({ ...good, multiplicities: [3, 1, 3, 3] })?.path).toBe('multiplicities.2');
    expect(nurbsViolation({ ...good, multiplicities: [2, 1, 1, 3] })?.path).toBe('multiplicities');
    expect(nurbsViolation({ ...good, multiplicities: [3, 2, 2, 3] })?.path).toBe('multiplicities');
  });
});

describe('evaluation and derivatives', () => {
  it('a cubic Bezier matches the closed form and its derivative', () => {
    const curve: NurbsCurveData = {
      degree: 3,
      poles: [
        [0, 0, 0],
        [1, 2, 0],
        [3, 2, 0],
        [4, 0, 0],
      ],
      knots: [0, 1],
      multiplicities: [4, 4],
    };
    const t = 0.37;
    const b = [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
    const expectedX = b[1]! * 1 + b[2]! * 3 + b[3]! * 4;
    const [point, tangent] = curveDerivatives(curve, t, 1);
    expect(point![0]).toBeCloseTo(expectedX, 14);
    const dx = 3 * (1 - t) ** 2 * 1 + 6 * t * (1 - t) * 2 + 3 * t * t * 1;
    expect(tangent![0]).toBeCloseTo(dx, 12);
    expect(evaluateCurve(curve, -1)).toEqual(curve.poles[0]);
    expect(evaluateCurve(curve, 9)).toEqual(curve.poles[3]);
  });

  it('derivatives agree with central differences on a rational curve', () => {
    const curve = curveOf(3, randomPoles(7, 5), [1, 2, 0.5, 1.5, 1, 3, 1]);
    const h = 1e-5;
    const u = 0.43;
    const [, d1, d2] = curveDerivatives(curve, u, 2);
    const plus = curveDerivatives(curve, u + h, 1);
    const minus = curveDerivatives(curve, u - h, 1);
    for (let c = 0; c < 3; c++) {
      expect(d1![c]).toBeCloseTo((evaluateCurve(curve, u + h)[c]! - evaluateCurve(curve, u - h)[c]!) / (2 * h), 5);
      expect(d2![c]).toBeCloseTo((plus[1]![c]! - minus[1]![c]!) / (2 * h), 4);
    }
    expect(sampleCurve(curve, 5)).toHaveLength(5);
  });
});

describe('edit operations (VC-SRF-08)', () => {
  it('knot insertion keeps the shape (polynomial and rational)', () => {
    for (const weights of [undefined, [1, 2, 0.5, 1.5, 1, 3, 1, 2]]) {
      const curve = curveOf(3, randomPoles(8, 11), weights);
      const once = insertKnot(curve, 0.37, 1) as NurbsCurveData;
      expect(once.poles).toHaveLength(9);
      expect(deviation(curve, once)).toBeLessThan(1e-12);
      const twice = insertKnot(once, 0.37, 2) as NurbsCurveData;
      expect(twice.multiplicities[twice.knots.indexOf(0.37)]).toBe(3);
      expect(deviation(curve, twice)).toBeLessThan(1e-12);
    }
  });

  it('knot insertion refuses an end knot, a repeat above the degree and a bad count', () => {
    const curve = curveOf(2, randomPoles(5, 3));
    expect(insertKnot(curve, 0, 1)).toMatch(/strictly inside/);
    expect(insertKnot(curve, 1, 1)).toMatch(/strictly inside/);
    expect(insertKnot(curve, 0.5, 3)).toMatch(/multiplicity 3 > degree 2/);
    expect(insertKnot(curve, 0.5, 0)).toMatch(/positive integer/);
  });

  it('degree elevation keeps the shape and the continuity (polynomial and rational)', () => {
    for (const weights of [undefined, [1, 2, 0.5, 1.5, 1, 3, 1]]) {
      const curve = curveOf(3, randomPoles(7, 21), weights);
      const raised = elevateDegree(curve, 2) as NurbsCurveData;
      expect(raised.degree).toBe(5);
      expect(nurbsViolation(raised)).toBeNull();
      expect(raised.multiplicities).toEqual(curve.multiplicities.map((m) => m + 2));
      expect(deviation(curve, raised)).toBeLessThan(1e-11);
    }
  });

  it('degree elevation refuses a bad step and the maximum degree', () => {
    const curve = curveOf(3, randomPoles(5, 2));
    expect(elevateDegree(curve, 0)).toMatch(/positive integer/);
    expect(elevateDegree(curve, 23)).toMatch(/exceeds the maximum 25/);
  });

  it('reverse flips the direction, keeping the shape', () => {
    const curve = curveOf(3, randomPoles(6, 8), [1, 2, 1, 1, 2, 1]);
    const back = reverseCurve(curve);
    expect(distance(evaluateCurve(back, 0), evaluateCurve(curve, 1))).toBeLessThan(1e-14);
    expect(distance(evaluateCurve(back, 0.3), evaluateCurve(curve, 0.7))).toBeLessThan(1e-13);
    expect(nurbsViolation(back)).toBeNull();
  });

  it('pole and weight edits validate their operands', () => {
    const curve = curveOf(2, randomPoles(4, 4));
    expect((movePole(curve, 1, [9, 9, 9]) as NurbsCurveData).poles[1]).toEqual([9, 9, 9]);
    expect(movePole(curve, 4, [0, 0, 0])).toMatch(/outside 0\.\.3/);
    const weighted = setWeight(curve, 1, 2) as NurbsCurveData;
    expect(weighted.weights).toEqual([1, 2, 1, 1]);
    expect(setWeight(curve, 9, 2)).toMatch(/outside/);
    expect(setWeight(curve, 1, 0)).toMatch(/> 0/);
  });
});

describe('banded solver', () => {
  it('solves a tridiagonal system with pivoting and reports singular matrices', () => {
    const rows = [
      [
        [0, 0.1],
        [1, 3],
      ],
      [
        [0, 2],
        [1, 1],
        [2, 1],
      ],
      [
        [1, 4],
        [2, 1],
      ],
    ] as const;
    const x = solveBanded(rows, [
      [3.1 * 1 + 3 * 2, 1],
      [2 + 2 + 3, 2],
      [8 + 3, 3],
    ]);
    expect(x).not.toBeNull();
    const singular = solveBanded(
      [
        [
          [0, 1],
          [1, 1],
        ],
        [
          [0, 1],
          [1, 1],
        ],
      ],
      [[1], [2]],
    );
    expect(singular).toBeNull();
  });
});

describe('interpolation (VC-SRF-08)', () => {
  const points: Vec3[] = Array.from({ length: 12 }, (_, i): Vec3 => [i, Math.sin(i / 2) * 3, Math.cos(i / 3) * 2]);

  it.each(['chord', 'centripetal', 'uniform'] as const)('%s parameterisation passes through every point', (parameterization) => {
    for (const degree of [1, 2, 3, 5]) {
      const result = interpolatePoints(points, { degree, parameterization });
      if ('code' in result) throw new Error(result.message);
      expect(result.residual).toBeLessThan(1e-12);
      expect(nurbsViolation(result.curve)).toBeNull();
      expect(distance(evaluateCurve(result.curve, 0), points[0]!)).toBeLessThan(1e-12);
      expect(distance(evaluateCurve(result.curve, 1), points[11]!)).toBeLessThan(1e-12);
    }
  });

  it('exact tangents are derivatives per unit parameter as given, not only directions', () => {
    const result = interpolatePoints(points, {
      degree: 3,
      parameterization: 'uniform',
      startTangent: [0, 7, 0],
      endTangent: [3, 0, 0],
      exactTangents: true,
    });
    if ('code' in result) throw new Error(result.message);
    const [, start] = curveDerivatives(result.curve, 0, 1);
    const [, end] = curveDerivatives(result.curve, 1, 1);
    expect(start![1]!).toBeCloseTo(7, 9);
    expect(end![0]!).toBeCloseTo(3, 9);
  });

  it('honours start and end tangent directions', () => {
    const result = interpolatePoints(points, { degree: 3, parameterization: 'chord', startTangent: [0, 1, 0], endTangent: [1, 0, 0] });
    if ('code' in result) throw new Error(result.message);
    expect(result.residual).toBeLessThan(1e-12);
    const [, start] = curveDerivatives(result.curve, 0, 1);
    const [, end] = curveDerivatives(result.curve, 1, 1);
    expect(start![0]! / Math.hypot(...start!)).toBeCloseTo(0, 10);
    expect(start![1]! / Math.hypot(...start!)).toBeCloseTo(1, 10);
    expect(end![0]! / Math.hypot(...end!)).toBeCloseTo(1, 10);
    expect(Math.abs(end![1]!)).toBeLessThan(1e-9);
    for (const tangents of [{ startTangent: [0, 1, 0] as Vec3 }, { endTangent: [1, 0, 0] as Vec3 }]) {
      const one = interpolatePoints(points, { degree: 3, parameterization: 'centripetal', ...tangents });
      if ('code' in one) throw new Error(one.message);
      expect(one.residual).toBeLessThan(1e-12);
    }
  });

  it('a cubic Hermite from two points and two tangents', () => {
    const result = interpolatePoints(
      [
        [0, 0, 0],
        [4, 0, 0],
      ],
      { degree: 3, parameterization: 'chord', startTangent: [0, 1, 0], endTangent: [0, -1, 0] },
    );
    if ('code' in result) throw new Error(result.message);
    expect(result.curve.poles).toHaveLength(4);
    expect(result.residual).toBeLessThan(1e-12);
  });

  it('reproduces a polynomial exactly (cubic through samples of a cubic)', () => {
    const cubic = (x: number): Vec3 => [x, x ** 3 - 2 * x, 0];
    const samples = [0, 0.5, 1, 1.5, 2, 3].map(cubic);
    const result = interpolatePoints(samples, { degree: 3, parameterization: 'uniform' });
    if ('code' in result) throw new Error(result.message);
    expect(result.residual).toBeLessThan(1e-12);
  });

  it('refuses bad input with a code', () => {
    expect(
      interpolatePoints(
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        { degree: 3, parameterization: 'chord' },
      ),
    ).toMatchObject({ code: 'SRF_POINTS_INSUFFICIENT' });
    expect(
      interpolatePoints(
        [
          [0, 0, 0],
          [1, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
        ],
        { degree: 2, parameterization: 'chord' },
      ),
    ).toMatchObject({ code: 'SRF_POINTS_COINCIDENT', index: 2 });
    expect(interpolatePoints(points, { degree: 30, parameterization: 'chord' })).toMatchObject({ code: 'SRF_NURBS_INVALID' });
    expect(interpolatePoints(points, { degree: 1, parameterization: 'chord', startTangent: [1, 0, 0] })).toMatchObject({
      code: 'SRF_NURBS_INVALID',
    });
  });

  it('interpolates 10 000 points within the time budget', () => {
    const many = Array.from({ length: 10_000 }, (_, i): Vec3 => [i * 0.01, Math.sin(i * 0.01), 0]);
    const started = performance.now();
    const result = interpolatePoints(many, { degree: 3, parameterization: 'chord' });
    if ('code' in result) throw new Error(result.message);
    expect(result.residual).toBeLessThan(1e-9);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('conics (VC-SRF-07)', () => {
  it('weight and rho are inverse, shoulder points match the reference data', () => {
    for (const row of conicCases.cases) {
      const [a, t, b] = [row.A, row.T, row.B].map((p): Vec3 => [p[0]!, p[1]!, 0]) as [Vec3, Vec3, Vec3];
      expect(conicWeight(row.rho)).toBeCloseTo(row.weight, 12);
      expect(conicRho(row.weight)).toBeCloseTo(row.rho, 12);
      const curve = conicCurve(a, t, b, row.rho);
      const mid = evaluateCurve(curve, 0.5);
      expect(mid[0]).toBeCloseTo(row.shoulder[0]!, 12);
      expect(mid[1]).toBeCloseTo(row.shoulder[1]!, 12);
      expect(rhoFromShoulder(a, t, b, [row.shoulder[0]!, row.shoulder[1]!, 0])).toBeCloseTo(row.rho, 9);
    }
  });

  it('rho = sqrt(2) - 1 is the exact unit quarter circle', () => {
    const curve = conicCurve([1, 0, 0], [1, 1, 0], [0, 1, 0], Math.SQRT2 - 1);
    for (let i = 0; i <= 16; i++) expect(Math.hypot(...evaluateCurve(curve, i / 16))).toBeCloseTo(1, 12);
    expect(curveLength(curve, 0, 1)).toBeCloseTo(Math.PI / 2, 10);
  });

  it('detects collinear corners and intersects tangent lines', () => {
    expect(isCollinear([0, 0, 0], [1, 1, 1], [2, 2, 2])).toBe(true);
    expect(isCollinear([0, 0, 0], [1, 1, 0], [2, 0, 0])).toBe(false);
    expect(tangentApex([1, 0, 0], [0, 1, 0], [0, 1, 0], [1, 0, 0])).toEqual([1, 1, 0]);
    expect(tangentApex([0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 0, 0])).toBeNull();
    expect(tangentApex([0, 0, 0], [1, 0, 0], [5, 1, 1], [0, 1, 0])).toBeNull();
    expect(rhoFromShoulder([0, 0, 0], [1, 1, 0], [2, 0, 0], [0, 5, 0])).toBeNull();
    expect(rhoFromShoulder([0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 5, 0])).toBeNull();
  });
});

describe('curvature (VC-SRF-05 curve part, VC-SRF-06)', () => {
  const circle = conicCurve([5, 0, 0], [5, 5, 0], [0, 5, 0], Math.SQRT2 - 1);

  it('a circle of radius 5 has curvature 0.2, constant, and no rate of change', () => {
    const normal = planeNormalOf(circle);
    expect(normal![2]).toBeCloseTo(1, 12);
    expect(Math.hypot(normal![0]!, normal![1]!)).toBeLessThan(1e-12);
    for (const u of [0, 0.25, 0.5, 0.9]) {
      const sample = curvatureAt(circle, u, normal);
      expect(sample.curvature).toBeCloseTo(0.2, 10);
      expect(sample.signedCurvature).toBeCloseTo(0.2, 10);
      expect(Math.abs(sample.dCurvatureDs)).toBeLessThan(1e-9);
      expect(sample.torsion).toBe(0);
    }
    expect(curvatureAt(circle, 0.5, null).dCurvatureDs).toBeCloseTo(0, 9);
  });

  it('y = x^3 has an inflection at the origin with dkappa/ds = 6 (planar and generic forms)', () => {
    // x(u) = 2u - 1, y(u) = (2u - 1)^3: Bezier poles of x are linear, those of y are -1, 1, -1, 1.
    const exact: NurbsCurveData = {
      degree: 3,
      poles: [
        [-1, -1, 0],
        [-1 / 3, 1, 0],
        [1 / 3, -1, 0],
        [1, 1, 0],
      ],
      knots: [0, 1],
      multiplicities: [4, 4],
    };
    expect(evaluateCurve(exact, 0.5)[0]).toBeCloseTo(0, 12);
    const sample = curvatureAt(exact, 0.5, planeNormalOf(exact));
    expect(sample.curvature).toBeLessThan(1e-9);
    expect(sample.dCurvatureDs).toBeCloseTo(6, 8);
    expect(curvatureAt(exact, 0.5, null).dCurvatureDs).toBeCloseTo(6, 8);
  });

  it('a helix has curvature r/(r^2+c^2) and torsion c/(r^2+c^2); a straight line has none', () => {
    const helix = interpolatePoints(
      Array.from({ length: 80 }, (_, i): Vec3 => [Math.cos(i / 8), Math.sin(i / 8), i / 40]),
      { degree: 5, parameterization: 'chord' },
    );
    if ('code' in helix) throw new Error(helix.message);
    expect(planeNormalOf(helix.curve)).toBeNull();
    const sample = curvatureAt(helix.curve, 0.5, null);
    expect(sample.curvature).toBeCloseTo(1 / 1.04, 3);
    expect(sample.torsion).toBeCloseTo(0.2 / 1.04, 3);
    const line = curveOf(1, [
      [0, 0, 0],
      [1, 1, 1],
    ]);
    const flat = curvatureAt(line, 0.5, null);
    expect(flat.curvature).toBe(0);
    expect(flat.normal).toEqual([0, 0, 0]);
    expect(planeNormalOf(line)).toBeNull();
  });

  it('flags a zero-speed sample as degenerate', () => {
    const cusp = curveOf(2, [
      [0, 0, 0],
      [0, 0, 0],
      [1, 0, 0],
    ]);
    expect(curvatureAt(cusp, 0, null).degenerate).toBe(true);
  });

  it('arc length of a straight Bezier equals its chord', () => {
    expect(
      curveLength(
        curveOf(3, [
          [0, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
          [3, 0, 0],
        ]),
        0,
        1,
      ),
    ).toBeCloseTo(3, 12);
    expect(
      curveLength(
        curveOf(1, [
          [0, 0, 0],
          [3, 4, 0],
        ]),
        1,
        0,
      ),
    ).toBeCloseTo(5, 12);
  });
});

describe('entity-aware helpers', () => {
  it('display points include both ends and resolve each span; extent and scale follow the poles', () => {
    const curve = curveOf(3, randomPoles(9, 33));
    const points = curveDisplayPoints(curve);
    expect(points[0]).toEqual(evaluateCurve(curve, 0));
    expect(distance(points[points.length - 1]!, evaluateCurve(curve, 1))).toBe(0);
    const { min, max } = poleExtent(curve);
    for (const point of points) for (let c = 0; c < 3; c++) expect(point[c]).toBeGreaterThanOrEqual(min[c]! - 1e-12);
    for (const point of points) for (let c = 0; c < 3; c++) expect(point[c]).toBeLessThanOrEqual(max[c]! + 1e-12);
    const doubled = scaleCurve(curve, 2);
    expect(distance(evaluateCurve(doubled, 0.4), evaluateCurve(curve, 0.4).map((v) => v * 2) as unknown as Vec3)).toBeLessThan(1e-12);
  });
});
