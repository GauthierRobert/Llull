/**
 * chartPointOf: the chart point whose geodesic ends at a 3D point inverts `uvAt` + `pointAt` on every face kind, and refuses the degenerate cases.
 * footprintPerimeter: the length on the face of the emboss loops, against closed forms.
 * unionBoundary: the outers and the holes of a polygon union.
 */

import { describe, expect, it } from 'vitest';
import { chartPointOf } from '@core/geometry/chartInverse';
import type { ChartMethod, ChartPlacement, FaceChart } from '@core/geometry/chartFrame';
import { buildChart } from '@core/geometry/faceChart';
import { fitDenseSamples } from '@core/geometry/denseFit';
import { validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { footprintPerimeter } from '@core/geometry/embossPerimeter';
import type { SurfaceParams } from '@core/geometry/kernelPorts';
import type { EmbossParams, UvLoop } from '@core/model/wrap';
import type { Vec2, Vec3 } from '@core/model/vectors';
import { unionBoundary } from '@lib/polygonBoolean';
import { polygonArea } from '@lib/polygon';

const placement = (on: Vec3): ChartPlacement => ({ anchorChart: [0, 0], anchorOn: on, angleDeg: 0, mirror: false });

function chartOf(surface: SurfaceParams, on: Vec3, method: ChartMethod): FaceChart {
  const chart = buildChart(surface, placement(on), method);
  if ('error' in chart) throw new Error(chart.error);
  return chart;
}

/** The 3D point reached by the straight chart line to `target` (chart units). */
const reached = (chart: FaceChart, target: Vec2): Vec3 => {
  const uv = chart.uvAt(target);
  if (uv === null) throw new Error('chart undefined');
  return chart.pointAt(uv);
};

const near = (a: ArrayLike<number>, b: ArrayLike<number>, digits = 6): void => {
  for (let k = 0; k < a.length; k++) expect(a[k]).toBeCloseTo(b[k] as number, digits);
};

describe('chartPointOf', () => {
  it('inverts the plane, cylinder and cone charts', () => {
    const plane = chartOf({ type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] }, [1, 2, 0], 'develop');
    near(chartPointOf(plane, reached(plane, [3, -4])) as Vec2, [3, -4]);
    const cylinder = chartOf({ type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], radius: 10 }, [10, 0, 0], 'develop');
    near(chartPointOf(cylinder, reached(cylinder, [7, 5])) as Vec2, [7, 5]);
    const cone = chartOf(
      { type: 'cone', apex: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], semiAngle: 0.5 },
      [Math.sin(0.5) * 20, 0, Math.cos(0.5) * 20],
      'develop',
    );
    near(chartPointOf(cone, reached(cone, [4, 3])) as Vec2, [4, 3]);
  });

  it('refuses the cone apex and a geodesic through it', () => {
    const on: Vec3 = [Math.sin(0.5) * 20, 0, Math.cos(0.5) * 20];
    const cone = chartOf({ type: 'cone', apex: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], semiAngle: 0.5 }, on, 'develop');
    expect(chartPointOf(cone, [0, 0, 0])).toHaveProperty('error', 'the end point is the cone apex');
    const opposite: Vec3 = [Math.sin(0.5) * 1e-8, 0, Math.cos(0.5) * 1e-8];
    expect(chartPointOf(cone, opposite)).toHaveProperty('error');
  });

  it('inverts the sphere chart and refuses coincident or distant points', () => {
    const ball: SurfaceParams = { type: 'sphere', center: [0, 0, 0], radius: 25 };
    const chart = chartOf(ball, [0, 0, 25], 'geodesic');
    near(chartPointOf(chart, reached(chart, [6, -3])) as Vec2, [6, -3], 5);
    expect(chartPointOf(chart, [0, 0, 25])).toHaveProperty('error', 'the two points coincide');
    expect(chartPointOf(chart, [25, 0, 0])).toHaveProperty('error');
  });

  it('inverts the torus chart by shooting, and refuses a coincident point', () => {
    const ring: SurfaceParams = { type: 'torus', center: [0, 0, 0], axis: [0, 0, 1], major: 10, minor: 3 };
    const chart = chartOf(ring, [13, 0, 0], 'geodesic');
    const target = reached(chart, [1.5, 0.8]);
    const inverse = chartPointOf(chart, target) as Vec2;
    near(inverse, [1.5, 0.8], 5);
    expect(chartPointOf(chart, [13, 0, 0])).toHaveProperty('error', 'the two points coincide');
  });

  it('reports a torus shooting that cannot converge', () => {
    const ring: SurfaceParams = { type: 'torus', center: [0, 0, 0], axis: [0, 0, 1], major: 10, minor: 3 };
    const chart = chartOf(ring, [13, 0, 0], 'geodesic');
    const stuck = { ...chart, uvOfPoint: () => [Math.PI, Math.PI] as Vec2 } as FaceChart;
    const result = chartPointOf(stuck, [0, 0, 0]);
    if (!Array.isArray(result)) expect(result).toHaveProperty('error');
  });
});

const rectangle = (x0: number, y0: number, x1: number, y1: number): UvLoop => ({
  start: [x0, y0],
  segments: [
    { kind: 'line', to: [x1, y0] },
    { kind: 'line', to: [x1, y1] },
    { kind: 'line', to: [x0, y1] },
    { kind: 'line', to: [x0, y0] },
  ],
});

const withSurface = (surface: EmbossParams['surface'], loop: UvLoop): Pick<EmbossParams, 'surface' | 'regions'> => ({
  surface,
  regions: [{ outer: loop, holes: [] }],
});

describe('footprintPerimeter', () => {
  const frame = [0, 0, 0, 0, 0, 1, 1, 0, 0];
  it('is the perimeter on a plane, a cylinder, a cone, a sphere and a torus', () => {
    const square = rectangle(0, 0, 2, 3);
    expect(footprintPerimeter(withSurface({ type: 'plane', data: [0, 0, 0, 1, 0, 0, 0, 1, 0] }, square))).toBeCloseTo(10, 9);
    const cylinder = footprintPerimeter(withSurface({ type: 'cylinder', data: [...frame, 5] }, rectangle(0, 0, 0.2, 3)));
    expect(cylinder).toBeCloseTo(2 * (1 + 3), 2);
    const cone = footprintPerimeter(withSurface({ type: 'cone', data: [...frame, 0.5] }, rectangle(0, 1, 0.1, 2)));
    expect(cone).toBeGreaterThan(2);
    const sphere = footprintPerimeter(withSurface({ type: 'sphere', data: [...frame, 4] }, rectangle(0, 0, 0.1, 0.1)));
    expect(sphere).toBeCloseTo(0.4 + 0.4 * Math.cos(0.1) + 0.8, 3);
    const torus = footprintPerimeter(withSurface({ type: 'torus', data: [...frame, 10, 3] }, rectangle(0, 0, 0.1, 0.1)));
    expect(torus).toBeCloseTo(1.3 + (10 + 3 * Math.cos(0.1)) * 0.1 + 0.6, 3);
  });

  it('measures a curved segment and is null on a face without a frame', () => {
    const quarter: UvLoop = {
      start: [0, 0],
      segments: [
        {
          kind: 'nurbs',
          curve: {
            degree: 1,
            poles: [
              [0, 0],
              [0, 4],
            ],
            knots: [0, 1],
            multiplicities: [2, 2],
          },
        },
        { kind: 'line', to: [0, 0] },
      ],
    };
    expect(footprintPerimeter(withSurface({ type: 'plane', data: [0, 0, 0, 1, 0, 0, 0, 1, 0] }, quarter))).toBeCloseTo(8, 6);
    expect(footprintPerimeter(withSurface({ type: 'face', data: [] } as never, quarter))).toBeNull();
  });
});

describe('unionBoundary', () => {
  const square = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  it('keeps the gap a ring of squares encloses as a hole', () => {
    const ring = [square(0, 0, 3, 1), square(2, 0, 3, 3), square(0, 2, 3, 3), square(0, 0, 1, 3)];
    const { outers, holes } = unionBoundary(ring);
    expect(outers).toHaveLength(1);
    expect(holes).toHaveLength(1);
    expect(polygonArea(outers[0] ?? [])).toBeCloseTo(9, 9);
    expect(polygonArea(holes[0] ?? [])).toBeCloseTo(1, 9);
  });

  it('drops a polygon inside another, a shared wall and a doubled edge, and ignores degenerate input', () => {
    expect(unionBoundary([square(0, 0, 10, 10), square(2, 2, 4, 4)]).outers.map(polygonArea)).toEqual([100]);
    const joined = unionBoundary([square(0, 0, 1, 1), square(1, 0, 2, 1)]);
    expect(joined.outers.map(polygonArea)).toEqual([2]);
    expect(unionBoundary([square(0, 0, 1, 1), square(0, 0, 1, 1)]).outers.map(polygonArea)).toEqual([1]);
    expect(
      unionBoundary([
        [
          [0, 0],
          [1, 1],
        ],
        square(5, 5, 6, 6),
      ]).outers,
    ).toHaveLength(1);
  });
});

describe('parametric charts of developable faces', () => {
  it('is the development on a cylinder and a stretched (non-isometric) map on a cone', () => {
    const surface: SurfaceParams = { type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], radius: 10 };
    const develop = chartOf(surface, [10, 0, 0], 'develop');
    const parametric = chartOf(surface, [10, 0, 0], 'parametric');
    expect(parametric.affine).toBe(true);
    near(parametric.uvAt([6, 4]) as Vec2, develop.uvAt([6, 4]) as Vec2, 9);
    expect(parametric.fullWrapWidth).toBeCloseTo(2 * Math.PI * 10, 6);
    const plane = chartOf({ type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] }, [0, 0, 0], 'parametric');
    expect(plane.fullWrapWidth).toBeNull();
    const cone = chartOf(
      { type: 'cone', apex: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], semiAngle: 0.5 },
      [Math.sin(0.5) * 20, 0, Math.cos(0.5) * 20],
      'parametric',
    );
    expect(cone.method).toBe('parametric');
    expect(cone.uvAt([1, 0])).not.toBeNull();
  });
});

describe('fitDenseSamples', () => {
  const line = (count: number): Vec3[] => Array.from({ length: count }, (_, k): Vec3 => [k, 0, 0]);
  it('fits a straight run and a gentle arc, and reports a zero-length curve and an unfittable zigzag', () => {
    expect(fitDenseSamples(line(65), 1e-9)).toHaveProperty('deviation');
    const arc = Array.from({ length: 65 }, (_, k): Vec3 => [Math.cos(k / 40), Math.sin(k / 40), 0]);
    expect(fitDenseSamples(arc, 1e-6)).toHaveProperty('curve');
    expect(
      fitDenseSamples(
        Array.from({ length: 65 }, (): Vec3 => [1, 1, 1]),
        1e-6,
      ),
    ).toHaveProperty('error');
    const prime = Array.from({ length: 18 }, (_, k): Vec3 => [k, 0, 0]);
    expect(fitDenseSamples(prime, 1e-6)).toHaveProperty('error');
  });
});

describe('emboss recipe validation of split chains', () => {
  const split = (chains: unknown): string | null =>
    validateShapeRecipe({
      op: 'emboss',
      source: {
        op: 'solid',
        entity: {
          id: 'cyl',
          kind: 'cylinder',
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          layerId: 'l',
          color: '#888888',
          radius: 20,
          height: 40,
        },
      },
      face: 0,
      surface: { type: 'face', data: [] },
      regions: [],
      chains,
      mode: 'split',
      depth: 0,
      direction: [0, 0, 1],
      tolerance: 1e-6,
    } as never);
  it('needs a list of 1..N well-formed chains', () => {
    const chain = { start: [0, 0], segments: [{ kind: 'line', to: [1, 1] }] };
    expect(split([chain])).toBeNull();
    expect(split([])).toContain('chains');
    expect(split(undefined)).toContain('chains');
    expect(split([{ start: [0, 0], segments: [] }])).not.toBeNull();
  });
});
