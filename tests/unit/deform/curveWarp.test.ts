import { describe, expect, it } from 'vitest';
import { mapPoles, mapSurfacePoles, refitCurve, refitSurface } from '@core/geometry/deform/curveWarp';
import { evaluateCurve } from '@lib/nurbs/evaluate';
import { evaluateSurface } from '@lib/nurbs/surface';
import type { NurbsCurveData } from '@lib/nurbs/types';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import type { Vec3 } from '@core/model/types';

const bend = ([x, y, z]: Vec3): Vec3 => [x, 50 - (50 - y) * Math.cos(z / 50), (50 - y) * Math.sin(z / 50)];

const line = (degree: number, length = 60): NurbsCurveData => {
  const count = degree + 1;
  return {
    degree,
    poles: Array.from({ length: count }, (_, k) => [3, 0, (length * k) / degree] as Vec3),
    knots: [0, 1],
    multiplicities: [degree + 1, degree + 1],
  };
};

describe('refit of curves and sheets (FR-DEF-17)', () => {
  it.each([1, 3, 7])('a degree %s line bent onto a circle stays within the tolerance of the arc', (degree) => {
    const fit = refitCurve(line(degree), bend, 0.01);
    expect(fit).not.toBeNull();
    const curve = fit?.data as NurbsCurveData;
    for (let k = 0; k <= 20; k++) {
      const p = evaluateCurve(curve, k / 20);
      expect(Math.abs(Math.hypot(p[1] - 50, p[2]) - 50)).toBeLessThan(0.011);
    }
    expect(fit?.maxError).toBeLessThanOrEqual(0.01);
  });

  it('refuses a fit the pole budget cannot reach', () => {
    const wild = ([x, y, z]: Vec3): Vec3 => [x, y + Math.sin(z * 40), z];
    expect(refitCurve(line(3, 600), wild, 1e-7)).toBeNull();
  });

  it('refits a degree 1 and a degree 3 sheet, and gives up on an impossible one', () => {
    for (const degree of [1, 3]) {
      const count = Math.max(degree + 1, 2);
      const surface: NurbsSurfaceData = {
        degreeU: degree,
        degreeV: degree,
        poles: Array.from({ length: count }, (_, i) =>
          Array.from({ length: count }, (_, j) => [(j * 6) / (count - 1) - 3, 0, (i * 40) / (count - 1)] as Vec3),
        ),
        knotsU: [0, 1],
        multiplicitiesU: [degree + 1, degree + 1],
        knotsV: [0, 1],
        multiplicitiesV: [degree + 1, degree + 1],
      };
      const fit = refitSurface(surface, bend, 0.02);
      expect(fit, `degree ${degree}`).not.toBeNull();
      const middle = evaluateSurface(fit?.data as NurbsSurfaceData, 0.5, 0.5);
      const expected = bend(evaluateSurface(surface, 0.5, 0.5));
      expect(Math.hypot(middle[0] - expected[0], middle[1] - expected[1], middle[2] - expected[2])).toBeLessThan(0.5);
      const crazy = ([x, y, z]: Vec3): Vec3 => [x, y + Math.sin(z * 30), z];
      expect(refitSurface(surface, crazy, 1e-9)).toBeNull();
    }
  });

  it('maps the poles of a curve and a sheet exactly', () => {
    const shift = (p: Vec3): Vec3 => [p[0] + 1, p[1] + 2, p[2] + 3];
    const moved = mapPoles(line(1), shift);
    expect(moved.poles[0]).toEqual([4, 2, 3]);
    expect(moved.knots).toEqual([0, 1]);
    const surface: NurbsSurfaceData = {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [0, 0, 0],
          [0, 1, 0],
        ],
        [
          [1, 0, 0],
          [1, 1, 0],
        ],
      ],
      knotsU: [0, 1],
      multiplicitiesU: [2, 2],
      knotsV: [0, 1],
      multiplicitiesV: [2, 2],
    };
    expect(mapSurfacePoles(surface, shift).poles[1]?.[1]).toEqual([2, 3, 3]);
  });
});

describe('degenerate maps', () => {
  it('a map that collapses the geometry to a point or a line never throws and either refits or is refused', () => {
    const point = (): Vec3 => [1, 2, 3];
    const flatLine = ([, , z]: Vec3): Vec3 => [0, 0, z];
    const curve = line(3);
    const surface: NurbsSurfaceData = {
      degreeU: 3,
      degreeV: 3,
      poles: Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => [j, 0, i * 10] as Vec3)),
      knotsU: [0, 1],
      multiplicitiesU: [4, 4],
      knotsV: [0, 1],
      multiplicitiesV: [4, 4],
    };
    const nowhere = ([x, , z]: Vec3): Vec3 => [x, z > 20 ? 1 : 0, 0];
    const ripple = ([x, y, z]: Vec3): Vec3 => [x, y + Math.sin(z * 300), z];
    for (const map of [point, flatLine, nowhere, ripple]) {
      expect(() => refitCurve(curve, map, 1e-6)).not.toThrow();
      expect(() => refitSurface(surface, map, 1e-6)).not.toThrow();
    }
    expect(refitCurve(curve, point, 1e-6)?.maxError ?? 0).toBeLessThanOrEqual(1e-6);
  });
});
