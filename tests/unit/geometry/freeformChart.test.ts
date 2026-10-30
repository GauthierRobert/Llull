/**
 * 03 WRP freeform charts (spec §14.10): the geodesic (exponential map by RK4 on the exact B-spline) and parametric charts of a B-spline face, checked against the
 * analytic charts of a cylinder and a sphere patch that are secretly the same surface, against the closed form of the saddle, and the named refusals (fold, edge).
 */

import { describe, expect, it } from 'vitest';
import type { ChartPlacement, FaceChart } from '@core/geometry/chartFrame';
import { measureDistortion } from '@core/geometry/chartDistortion';
import { buildChart } from '@core/geometry/faceChart';
import { buildFreeformChart, surfaceOfPort } from '@core/geometry/freeformChart';
import { evaluateSurface } from '@core/lib/nurbs/surface';
import type { Vec2, Vec3 } from '@core/model/types';
import { cylinderPatch, saddlePatch, spherePatch } from '../../helpers/freeformSurfaces';

const placementAt = (anchorOn: Vec3): ChartPlacement => ({ anchorChart: [0, 0], anchorOn, angleDeg: 0, mirror: false });
const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const chartOf = (result: ReturnType<typeof buildFreeformChart>): FaceChart => {
  if ('error' in result) throw new Error(result.error);
  return result;
};

/** Sketch points on a spiral and a ring within `reach` of the anchor. */
const probes = (reach: number): Vec2[] =>
  Array.from({ length: 24 }, (_, k): Vec2 => {
    const angle = (k * 2 * Math.PI) / 24;
    const radius = reach * (0.2 + 0.8 * ((k % 6) / 5));
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  });

describe('buildFreeformChart: a B-spline that is secretly an analytic surface gives the analytic chart', () => {
  it('cylinder patch: geodesic and parametric(geodesic = development) match the analytic cylinder chart point for point', () => {
    const radius = 20;
    const patch = cylinderPatch(radius, -Math.PI / 4, Math.PI / 4, 40);
    const surface = surfaceOfPort(patch);
    const uv0: Vec2 = [0.5, 0.5];
    const anchor = evaluateSurface(surface, uv0[0], uv0[1]);
    const mine = chartOf(buildFreeformChart(patch, uv0, placementAt(anchor), 'geodesic'));
    const analytic = buildChart(
      { type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], radius },
      placementAt(anchor),
      'geodesic',
    );
    if ('error' in analytic) throw new Error(analytic.error);
    let worst = 0;
    for (const point of probes(14)) {
      const a = mine.uvAt(point);
      const b = analytic.uvAt(point);
      expect(a).not.toBeNull();
      if (a === null || b === null) continue;
      worst = Math.max(worst, distance(mine.pointAt(a), analytic.pointAt(b)));
    }
    expect(worst).toBeLessThan(1e-7 * radius);
    expect(mine.method).toBe('geodesic');
    expect(mine.kind).toBe('freeform');
    expect(mine.fullWrapWidth).toBeNull();
  });

  it('sphere patch: the geodesic chart matches the analytic sphere chart (great circles) and the Jacobi field gives the right circumference', () => {
    const radius = 25;
    const patch = spherePatch(radius, -Math.PI / 3, Math.PI / 3, -Math.PI / 3, Math.PI / 3);
    const surface = surfaceOfPort(patch);
    const uv0: Vec2 = [0.5, 0.5];
    const anchor = evaluateSurface(surface, uv0[0], uv0[1]);
    expect(distance(anchor, [radius, 0, 0])).toBeLessThan(1e-9);
    const mine = chartOf(buildFreeformChart(patch, uv0, placementAt(anchor), 'geodesic'));
    const analytic = buildChart({ type: 'sphere', center: [0, 0, 0], radius }, placementAt(anchor), 'geodesic');
    if ('error' in analytic) throw new Error(analytic.error);
    let worst = 0;
    for (const point of probes(20)) {
      const a = mine.uvAt(point);
      const b = analytic.uvAt(point);
      expect(a).not.toBeNull();
      if (a === null || b === null) continue;
      worst = Math.max(worst, distance(mine.pointAt(a), analytic.pointAt(b)));
    }
    // RK4 on the exact surface, no analytic input: the error of the integration alone
    expect(worst).toBeLessThan(1e-6 * radius);
    // a chart circle of radius rho has the 3D circumference 2 pi R sin(rho / R): the chord ratio of two near points on it
    const rho = 15;
    const [p, q]: [Vec2, Vec2] = [
      [rho, 0],
      [rho * Math.cos(1e-3), rho * Math.sin(1e-3)],
    ];
    const chord = distance(mine.pointAt(mine.uvAt(p) as Vec2), mine.pointAt(mine.uvAt(q) as Vec2));
    expect(chord / (rho * 1e-3)).toBeCloseTo(Math.sin(rho / radius) / (rho / radius), 5);
  });

  it('sphere patch: the parametric chart is affine in (u, v) with the iso-curve speeds at the anchor, and its distortion is measured', () => {
    const radius = 25;
    const patch = spherePatch(radius, -Math.PI / 3, Math.PI / 3, -Math.PI / 3, Math.PI / 3);
    const surface = surfaceOfPort(patch);
    const anchor = evaluateSurface(surface, 0.5, 0.5);
    const chart = chartOf(buildFreeformChart(patch, [0.5, 0.5], placementAt(anchor), 'parametric'));
    expect(chart.affine).toBe(true);
    const uv = chart.uvAt([3, 4]) as Vec2;
    const uv2 = chart.uvAt([6, 8]) as Vec2;
    expect(uv2[0] - 0.5).toBeCloseTo(2 * (uv[0] - 0.5), 12);
    expect(uv2[1] - 0.5).toBeCloseTo(2 * (uv[1] - 0.5), 12);
    const line = [{ kind: 'line' as const, from: [0, 0] as Vec2, to: [5, 0] as Vec2 }];
    const near = measureDistortion(chart, [line], [], 1);
    expect(near.maxLengthStrain).toBeLessThan(0.01);
    expect(chart.uvAt([1e6, 0])).toBeNull();
    expect(chart.diagnose?.([1e6, 0])).toBe('outside');
    expect(chart.diagnose?.([1, 0])).toBeNull();
  });
});

describe('buildFreeformChart: a genuinely freeform saddle', () => {
  it('geodesics leave the anchor along the +u tangent: a chart line along x is a geodesic of the saddle (arc length kept), and the saddle strain is measured', () => {
    const patch = saddlePatch(0.02, 20);
    const surface = surfaceOfPort(patch);
    const anchor = evaluateSurface(surface, 0.5, 0.5);
    const chart = chartOf(buildFreeformChart(patch, [0.5, 0.5], placementAt(anchor), 'geodesic'));
    // the u iso curve through the centre is a geodesic of the symmetric saddle (the plane y = 0 is a symmetry plane): the radial length equals the arc length
    const rho = 10;
    const uv = chart.uvAt([rho, 0]) as Vec2;
    expect(uv[1]).toBeCloseTo(0.5, 9);
    let arcLength = 0;
    let previous = anchor;
    for (let k = 1; k <= 2000; k++) {
      const at = chart.pointAt([0.5 + ((uv[0] - 0.5) * k) / 2000, 0.5]);
      arcLength += distance(previous, at);
      previous = at;
    }
    expect(arcLength).toBeCloseTo(rho, 6);
    // circumference of a geodesic circle: J(rho) = sinh(2 k rho) / (2 k) for K = -4 k^2 near the centre; the real saddle is flatter away from it
    const small = 2;
    const [a, b]: [Vec2, Vec2] = [
      [small, 0],
      [small * Math.cos(1e-3), small * Math.sin(1e-3)],
    ];
    const ratio = distance(chart.pointAt(chart.uvAt(a) as Vec2), chart.pointAt(chart.uvAt(b) as Vec2)) / (small * 1e-3);
    const closedForm = Math.sinh(2 * 0.02 * small) / (2 * 0.02 * small);
    expect(ratio / closedForm - 1).toBeLessThan(0.02);
    expect(ratio).toBeGreaterThan(1);
    const circle = Array.from({ length: 16 }, (_, k) => ({
      kind: 'line' as const,
      from: [8 * Math.cos((k * 2 * Math.PI) / 16), 8 * Math.sin((k * 2 * Math.PI) / 16)] as Vec2,
      to: [8 * Math.cos(((k + 1) * 2 * Math.PI) / 16), 8 * Math.sin(((k + 1) * 2 * Math.PI) / 16)] as Vec2,
    }));
    const measured = measureDistortion(chart, [circle], [], 1);
    expect(measured.maxLengthStrain).toBeGreaterThan(0.005);
    expect(measured.maxLengthStrain).toBeLessThan(0.25);
    expect(measured.samples).toBeGreaterThan(100);
  });

  it('areaG integrates the area element: the area of a rectangle in (u, v) matches the surface area of the saddle strip', () => {
    const patch = saddlePatch(0.02, 20);
    const surface = surfaceOfPort(patch);
    const chart = chartOf(buildFreeformChart(patch, [0.5, 0.5], placementAt(evaluateSurface(surface, 0.5, 0.5)), 'geodesic'));
    // area of [0.25, 0.75]^2 as the difference of the antiderivative at v = 0.75 and 0.25, integrated in u
    let area = 0;
    for (let k = 0; k < 400; k++) {
      const u = 0.25 + ((k + 0.5) * 0.5) / 400;
      area += (chart.areaG(0.75, u) - chart.areaG(0.25, u)) * (0.5 / 400);
    }
    // the same area by the midpoint rule on the graph z = k (x^2 - y^2): the integral of sqrt(1 + 4 k^2 (x^2 + y^2)) over [-10, 10]^2
    let reference = 0;
    for (let i = 0; i < 400; i++)
      for (let j = 0; j < 400; j++) {
        const [x, y] = [-10 + ((i + 0.5) * 20) / 400, -10 + ((j + 0.5) * 20) / 400];
        reference += Math.sqrt(1 + 4 * 0.02 ** 2 * (x * x + y * y)) * (20 / 400) ** 2;
      }
    expect(Math.abs(area / reference - 1)).toBeLessThan(1e-6);
    expect(area).toBeGreaterThan(400);
  });

  it('metricBound bounds the 3D length per unit of (u, v) and uvOfPoint finds the closest point of the surface', () => {
    const patch = saddlePatch(0.02, 20);
    const surface = surfaceOfPort(patch);
    const chart = chartOf(buildFreeformChart(patch, [0.5, 0.5], placementAt(evaluateSurface(surface, 0.5, 0.5)), 'geodesic'));
    const [p, q] = [chart.pointAt([0.3, 0.6]), chart.pointAt([0.31, 0.6])];
    expect(distance(p, q) / 0.01).toBeLessThan(chart.metricBound(0));
    const uv = chart.uvOfPoint(chart.pointAt([0.3, 0.6]));
    expect(uv[0]).toBeCloseTo(0.3, 8);
    expect(uv[1]).toBeCloseTo(0.6, 8);
    const above = chart.uvOfPoint([p[0], p[1], p[2] + 0.001]);
    expect(above[0]).toBeCloseTo(0.3, 3);
    const n = chart.normalAt([0.5, 0.5]);
    expect(n[2]).toBeCloseTo(1, 12);
  });
});

describe('buildFreeformChart: named refusals', () => {
  it('on a sphere patch of 178 degrees the exponential map folds at the antipode: diagnose says fold, uvAt is null, closer points are fine, past the edge is outside', () => {
    const radius = 10;
    const wide = (89 * Math.PI) / 180;
    const patch = spherePatch(radius, -wide, wide, -0.3, 0.3);
    const surface = surfaceOfPort(patch);
    const anchor = evaluateSurface(surface, 0.001, 0.5);
    const chart = chartOf(buildFreeformChart(patch, [0.001, 0.5], placementAt(anchor), 'geodesic'));
    expect(chart.diagnose?.([2 * radius, 0])).toBeNull();
    expect(chart.uvAt([2 * radius, 0])).not.toBeNull();
    expect(chart.diagnose?.([3.05 * radius, 0])).toBe('fold');
    expect(chart.uvAt([3.05 * radius, 0])).toBeNull();
    expect(chart.diagnose?.([-5, 0])).toBe('outside');
    expect(chart.diagnose?.([0, 0])).toBeNull();
    expect(chart.nullMeaning).toContain('folds');
    const parametric = chartOf(buildFreeformChart(patch, [0.001, 0.5], placementAt(anchor), 'parametric'));
    expect(parametric.nullMeaning).not.toContain('folds');
    expect(parametric.metricBound(0)).toBeGreaterThan(radius);
  });

  it('a periodic surface and a degenerate anchor are refused with an error text', () => {
    const periodic = { ...cylinderPatch(5, 0, 1, 2), periodicU: true };
    expect(buildFreeformChart(periodic, [0.5, 0.5], placementAt([5, 0, 0]), 'geodesic')).toEqual({
      error: expect.stringContaining('periodic') as string,
    });
    const collapsed = spherePatch(5, 0, 1, 0, 1);
    const pole = { ...collapsed, poles: collapsed.poles.map((row) => row.map((): Vec3 => [0, 0, 0])) };
    expect(buildFreeformChart(pole, [0.5, 0.5], placementAt([0, 0, 0]), 'geodesic')).toEqual({
      error: expect.stringContaining('degenerate') as string,
    });
  });
});
