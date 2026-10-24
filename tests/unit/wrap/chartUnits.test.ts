/**
 * Units under the wrap commands, tested directly where the commands cannot reach their branches: seam-continuous (u, v), chain end snapping, the distortion measure, the sphere and
 * torus chart edges, the decal image and the wrap decal patch.
 */

import { describe, expect, it } from 'vitest';
import { continuousUv, snapChainEnds } from '@core/commands/wrap/splitChains';
import { measureDistortion, type UvChain } from '@core/geometry/chartDistortion';
import type { ChartPlacement, FaceChart } from '@core/geometry/chartFrame';
import { buildChart } from '@core/geometry/faceChart';
import { torusGeodesicEnd } from '@core/geometry/curvedChart';
import { strokeRegions } from '@core/geometry/strokeRegions';
import { decalImage } from '@core/geometry/decalImage';
import { decalPatch } from '@core/geometry/decal';
import type { SurfaceParams } from '@core/geometry/kernelPorts';
import type { Decal } from '@core/model/types';
import type { UvLoop } from '@core/model/wrap';
import type { Vec2, Vec3 } from '@core/model/vectors';

const placement = (on: Vec3, chart: Vec2 = [0, 0]): ChartPlacement => ({ anchorChart: chart, anchorOn: on, angleDeg: 0, mirror: false });
const chartOf = (surface: SurfaceParams, on: Vec3, method: 'develop' | 'geodesic' | 'parametric', anchor: Vec2 = [0, 0]): FaceChart => {
  const chart = buildChart(surface, placement(on, anchor), method);
  if ('error' in chart) throw new Error(chart.error);
  return chart;
};
const SPHERE: SurfaceParams = { type: 'sphere', center: [0, 0, 0], radius: 25 };
const TORUS: SurfaceParams = { type: 'torus', center: [0, 0, 0], axis: [0, 0, 1], major: 10, minor: 3 };

describe('continuousUv', () => {
  it('removes the 2 pi jumps of a periodic axis in either direction and leaves a non-periodic one alone', () => {
    const jumpy: Vec2[] = [
      [3, 3],
      [-3, -3],
      [-2.5, -2.9],
      [3, 3],
    ];
    const both = continuousUv(jumpy, [true, true]);
    for (let k = 1; k < both.length; k++) {
      expect(Math.abs((both[k] as Vec2)[0] - (both[k - 1] as Vec2)[0])).toBeLessThan(Math.PI);
      expect(Math.abs((both[k] as Vec2)[1] - (both[k - 1] as Vec2)[1])).toBeLessThan(Math.PI);
    }
    expect(continuousUv(jumpy, [false, false])).toEqual(jumpy);
  });
});

describe('snapChainEnds', () => {
  const chain = (a: Vec2, b: Vec2): UvLoop => ({
    start: a,
    segments: [{ kind: 'nurbs', curve: { degree: 1, poles: [a, b], knots: [0, 1], multiplicities: [2, 2] } }],
  });
  it('merges the ends that meet, leaves far ends and line chains as they are', () => {
    const [first, second] = snapChainEnds([chain([0, 0], [1, 0]), chain([1.00001, 0], [1, 1])], 1e-3) as [UvLoop, UvLoop];
    const end = (loop: UvLoop, last: boolean): Vec2 => {
      const segment = loop.segments[0];
      if (segment?.kind !== 'nurbs') throw new Error('nurbs expected');
      return segment.curve.poles[last ? 1 : 0] as Vec2;
    };
    expect(end(first, true)).toEqual(end(second, false));
    expect(end(first, false)).toEqual([0, 0]);
    const line: UvLoop = { start: [0, 0], segments: [{ kind: 'line', to: [1, 1] }] };
    expect(snapChainEnds([line, { start: [0, 0], segments: [] }], 1e-3)).toEqual([line, { start: [0, 0], segments: [] }]);
  });
});

describe('measureDistortion', () => {
  const sphere = chartOf(SPHERE, [0, 0, 25], 'geodesic');
  const line = (from: Vec2, to: Vec2): { kind: 'line'; from: Vec2; to: Vec2 } => ({ kind: 'line', from, to });
  const square = (half: number): UvChain => ({
    pieces: [
      line([-half, -half], [half, -half]),
      line([half, -half], [half, half]),
      line([half, half], [-half, half]),
      line([-half, half], [-half, -half]),
    ],
    hole: false,
  });

  it('is zero for a development and for no chains, and measures the signed worst stretch of a sphere', () => {
    const flat = chartOf({ type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] }, [0, 0, 0], 'develop');
    expect(measureDistortion(flat, [[line([0, 0], [1, 1])]], [], 0).samples).toBe(0);
    const none = measureDistortion(sphere, [], [], 0);
    expect(none).toMatchObject({ maxLengthStrain: 0, meanLengthStrain: 0, areaRatio: 1, worst: null, samples: 0 });
    const ring = square(5).pieces;
    const uvSquare = square(0.2);
    const outer = measureDistortion(sphere, [ring], [uvSquare], 100);
    expect(outer.samples).toBeGreaterThan(0);
    expect(outer.maxLengthStrain).toBeGreaterThan(0);
    expect(outer.areaRatio).toBeGreaterThan(0.9);
    expect(outer.areaRatio).toBeLessThan(1.1);
    const holed = measureDistortion(sphere, [ring], [uvSquare, { ...square(0.08), hole: true }], 100 - 16);
    expect(holed.areaRatio).toBeGreaterThan(0.9);
  });

  it('skips pieces the chart does not reach and zero-length pieces', () => {
    const far = measureDistortion(sphere, [[line([100, 0], [101, 0])]], [], 0);
    expect(far.samples).toBe(0);
    const point = measureDistortion(sphere, [[line([1, 1], [1, 1])], [line([0, 0], [2, 0])]], [], 0);
    expect(point.samples).toBeGreaterThan(0);
  });
});

describe('sphere and torus charts', () => {
  it('maps a sphere point back to its (longitude, latitude), parametric charts are limited to the reach, the pole frame is defined', () => {
    const chart = chartOf(SPHERE, [0, 0, 25], 'geodesic');
    const uv = chart.uvAt([5, 3]) as Vec2;
    const back = chart.uvOfPoint(chart.pointAt(uv));
    expect(back[0]).toBeCloseTo(uv[0], 9);
    expect(back[1]).toBeCloseTo(uv[1], 9);
    expect(chart.uvAt([1000, 0])).toBeNull();
    const parametric = chartOf(SPHERE, [25, 0, 0], 'parametric');
    expect(parametric.uvAt([0, 1000])).toBeNull();
    expect(parametric.uvAt([3, 2])).not.toBeNull();
    expect(chartOf(SPHERE, [0, 25, 0], 'geodesic').uvAt([1, 1])).not.toBeNull();
  });

  it('torus: the geodesic charts reach as far as the tube allows, the anchor on the axis is refused, a zero displacement is the anchor', () => {
    const chart = chartOf(TORUS, [13, 0, 0], 'geodesic');
    expect(chart.uvAt([0, 0])).toEqual([0, 0]);
    expect(chart.uvAt([1000, 0])).toBeNull();
    const refused = buildChart(TORUS, placement([0, 0, 3]), 'geodesic');
    expect(refused).toHaveProperty('error');
    expect(torusGeodesicEnd(10, 3, 0, 0, 1)[0]).toBeGreaterThan(0);
    const parametric = chartOf(TORUS, [13, 0, 0], 'parametric');
    expect(parametric.uvAt([1, 1])).not.toBeNull();
  });
});

describe('decalImage', () => {
  const base = { text: 'AB', color: '#ff0000', width: 2, height: 1 };
  it('draws the built-in block font without a mask, a mask in the ink colour over an optional background, and survives damaged data', () => {
    expect(decalImage(base).width).toBeGreaterThan(0);
    const mask = { width: 8, height: 1, bits: 'gA==' };
    const plain = decalImage({ ...base, mask });
    expect(Array.from(plain.rgba.slice(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(plain.rgba.slice(4, 8))).toEqual([0, 0, 0, 0]);
    const backed = decalImage({ ...base, mask, background: '#00ff00' });
    expect(Array.from(backed.rgba.slice(4, 8))).toEqual([0, 255, 0, 255]);
    const badBackground = decalImage({ ...base, mask, background: 'green' });
    expect(Array.from(badBackground.rgba.slice(4, 8))).toEqual([0, 0, 0, 0]);
    const badColour = decalImage({ ...base, color: 'red', mask });
    expect(Array.from(badColour.rgba.slice(0, 4))).toEqual([255, 255, 255, 255]);
    const damaged = decalImage({ ...base, mask: { width: 8, height: 1, bits: '***' } });
    expect(damaged.rgba.every((byte) => byte === 0)).toBe(true);
  });
});

describe('wrap decal patch', () => {
  const decal = (extra: Partial<Decal>): Decal => ({
    id: 'd',
    text: 'A',
    center: [20, 0, 0],
    normal: [1, 0, 0],
    angle: 0,
    width: 10,
    height: 4,
    depth: 1,
    color: '#ffffff',
    mapping: 'wrap',
    wrap: { type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], radius: 20 },
    ...extra,
  });
  it('is empty beyond one turn, for a cone the decal straddles the apex of, and for a decal centred on the apex', () => {
    expect(decalPatch(decal({}), []).positions.length).toBeGreaterThan(0);
    expect(decalPatch(decal({ width: 200 }), []).positions).toEqual([]);
    const cone = { type: 'cone' as const, apex: [0, 0, 0] as Vec3, axis: [0, 0, 1] as Vec3, xDir: [1, 0, 0] as Vec3, semiAngle: 0.5 };
    const near = decal({ wrap: cone, center: [Math.sin(0.5) * 1, 0, Math.cos(0.5) * 1], width: 1, height: 2 });
    expect(decalPatch(near, []).positions).toEqual([]);
    const degenerate = decal({ wrap: cone, center: [0, 0, 0] });
    expect(decalPatch(degenerate, []).positions).toEqual([]);
  });
});

describe('strokeRegions', () => {
  const ring = (half: number): Vec2[] => [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
    [-half, -half],
  ];
  it('gives an island inside a stroked ring to the smallest outline round it, and refuses a bad width and an empty stroke', () => {
    const regions = strokeRegions([ring(10), ring(4)], 1);
    if ('error' in regions) throw new Error(regions.error);
    expect(regions).toHaveLength(2);
    expect(regions.map((region) => region.holes.length)).toEqual([1, 1]);
    expect(strokeRegions([ring(10)], 0)).toHaveProperty('error');
    expect(strokeRegions([[[0, 0]]], 1)).not.toHaveProperty('error');
    expect(
      strokeRegions(
        [
          [],
          [
            [1, 1],
            [1, 1],
          ],
        ],
        1,
      ),
    ).toHaveProperty('error');
  });
});
