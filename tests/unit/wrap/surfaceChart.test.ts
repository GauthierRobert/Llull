/**
 * 03 WRP M0 / M2 core math without a kernel: the promoted developable chart (`geometry/surfaceChart`), the wrap chart on plane / cylinder / cone
 * (VC-WRP-01, 02, 06, 07, 37), planar segments, 2D NURBS helpers, curve fits and the emboss closed forms (VC-WRP-10, 12).
 */

import { describe, expect, it } from 'vitest';
import type { PartSurface } from '@core/model/composites';
import { bezier2, arc2, mapCurve2, pointAt2, sample2 } from '@lib/nurbs/curve2d';
import { directionOnFace, fromFlat, isDevelopable, normalAt, toFlat, zeroDirection } from '@core/geometry/surfaceChart';
import { embossClosedForm, regionsAreas } from '@core/geometry/embossVolume';
import { segmentArea, segmentLength, segmentOfCurve, segmentOfOutline, sampleSegment, mapSegment2 } from '@core/geometry/planeSegments';
import type { FaceChart } from '@core/geometry/chartFrame';
import { buildFaceChart } from '@core/geometry/wrapChart';
import { curve3d, extentOf, fitBySampling, isMappingError, lengthOnFace, mapPieces, pcurveOf } from '@core/geometry/wrapCurves';
import type { SurfaceParams } from '@core/geometry/kernelPorts';
import type { EmbossParams, UvLoop, UvRegion } from '@core/model/wrap';
import type { Vec2, Vec3 } from '@core/model/types';

const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);

const plane: PartSurface = { type: 'plane', origin: [1, 2, 3], xDir: [1, 0, 0], yDir: [0, 1, 0], normal: [0, 0, 1] };
const cylinder: PartSurface = { type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], radius: 20 };
const cone: PartSurface = { type: 'cone', apex: [0, 0, 40], axis: [0, 0, -1], xDir: [1, 0, 0], semiAngle: Math.atan2(20, 40) };

describe('geometry/surfaceChart: the developable charts promoted from composites (M0)', () => {
  it('maps points to the flat and back (plane, cylinder, cone) and reports the offset from the face', () => {
    for (const surface of [plane, cylinder, cone]) {
      expect(isDevelopable(surface)).toBe(true);
      if (!isDevelopable(surface)) continue;
      const flat: Vec2 = surface.type === 'cone' ? [10, 12] : [3, 4];
      const point = fromFlat(surface, flat);
      const hit = toFlat(surface, point);
      expect(hit.offset).toBeCloseTo(0, 9);
      const back = fromFlat(surface, hit.uv);
      expect(Math.hypot(back[0] - point[0], back[1] - point[1], back[2] - point[2])).toBeLessThan(1e-9);
    }
    const outside = toFlat(cylinder as Extract<PartSurface, { type: 'cylinder' }>, [21, 0, 5]);
    expect(outside.offset).toBeCloseTo(1, 12);
    expect(outside.uv[1]).toBe(5);
    const apexSide = toFlat(cone as Extract<PartSurface, { type: 'cone' }>, [0, 0, 40]);
    expect(apexSide.uv).toEqual([0, 0]);
  });

  it('keeps lengths: the development of the cone r 20 h 40 is a 2.80993 rad sector, normals are unit and outward', () => {
    const c = cone as Extract<PartSurface, { type: 'cone' }>;
    expect(2 * Math.PI * Math.sin(c.semiAngle)).toBeCloseTo(2.80992589242, 10);
    const a = fromFlat(c, [30, 0]);
    const b = fromFlat(c, [30 * Math.cos(0.1), 30 * Math.sin(0.1)]);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThan(0);
    for (const surface of [plane, cylinder, cone] as const) {
      if (!isDevelopable(surface)) continue;
      const n = normalAt(surface, surface.type === 'cone' ? [10, 12] : [3, 0]);
      expect(Math.hypot(...n)).toBeCloseTo(1, 12);
    }
    expect(zeroDirection(plane as never, [1, 1])).toEqual([1, 0]);
    expect(zeroDirection(cylinder as never, [1, 1])).toEqual([0, 1]);
    expect(zeroDirection(cone as never, [3, 4])).toEqual([0.6, 0.8]);
    expect(zeroDirection(cone as never, [0, 0])).toEqual([1, 0]);
    const along = directionOnFace(cone as never, [10, 12], [0.6, 0.8]);
    expect(Math.hypot(...along)).toBeCloseTo(1, 9);
    const circumferential = directionOnFace(cylinder as never, [0, 5], [1, 0]);
    expect(circumferential[1]).toBeCloseTo(1, 6);
    expect(isDevelopable({ type: 'sphere', center: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], radius: 1 })).toBe(false);
  });
});

const cylinderParams: SurfaceParams = { type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], radius: 20 };
const coneParams: SurfaceParams = { type: 'cone', apex: [0, 0, 40], axis: [0, 0, -1], xDir: [1, 0, 0], semiAngle: Math.atan2(20, 40) };
const planeParams: SurfaceParams = { type: 'plane', origin: [0, 0, 5], normal: [0, 0, 1], xDir: [1, 0, 0] };

const chartOf = (surface: SurfaceParams, on: Vec3, extra: { angleDeg?: number; mirror?: boolean; chart?: Vec2 } = {}): FaceChart => {
  const built = buildFaceChart(surface, {
    anchorChart: extra.chart ?? [0, 0],
    anchorOn: on,
    angleDeg: extra.angleDeg ?? 0,
    mirror: extra.mirror ?? false,
  });
  if ('error' in built) throw new Error(built.error);
  return built;
};

describe('geometry/wrapChart: the sketch-to-face chart (VC-WRP-01, 02, 06, 07, 37)', () => {
  it('cylinder: a chart line of 30 mm keeps its length at 0 / 30 / 45 / 60 / 90 degrees and turns into a helix of pitch 2 pi r tan(beta)', () => {
    const chart = chartOf(cylinderParams, [20, 0, 0]);
    expect(chart.fullWrapWidth).toBeCloseTo(125.663706144, 8);
    for (const [beta, span] of [
      [0, 1.5],
      [30, 1.29903810568],
      [45, 1.06066017178],
      [60, 0.75],
      [90, 0],
    ] as const) {
      const turned = chartOf(cylinderParams, [20, 0, 0], { angleDeg: beta });
      const piece = { kind: 'line', from: [-15, 0], to: [15, 0] } as const;
      const mapped = mapPieces(turned, [piece], 1e-6);
      if (isMappingError(mapped)) throw new Error(mapped.error);
      expect(relative(lengthOnFace(turned, mapped), 30)).toBeLessThan(1e-9);
      const start = turned.pointAt(sampleSegment(mapped[0] as never, 2)[0] as Vec2);
      const end = turned.pointAt(sampleSegment(mapped[0] as never, 2)[1] as Vec2);
      expect(Math.abs(Math.abs(Math.atan2(end[1], end[0]) - Math.atan2(start[1], start[0])) - span)).toBeLessThan(1e-9);
    }
    expect(chart.metricBound(10)).toBeGreaterThan(1);
  });

  it('cylinder: mirror flips the sketch y axis, the anchor shifts the sketch, circles keep 2 pi a', () => {
    const base = chartOf(cylinderParams, [20, 0, 0]);
    const mirrored = chartOf(cylinderParams, [20, 0, 0], { mirror: true });
    const a = base.uvAt([0, 3]) as Vec2;
    const b = mirrored.uvAt([0, 3]) as Vec2;
    expect(a[1]).toBeCloseTo(3, 12);
    expect(b[1]).toBeCloseTo(-3, 12);
    const shifted = chartOf(cylinderParams, [20, 0, 0], { chart: [5, 5] });
    expect(shifted.uvAt([5, 5])).toEqual(base.uvAt([0, 0]));
    for (const radius of [4, 8, 15]) {
      const circle = [
        segmentOfCurve({
          type: 'arc',
          points: [
            [radius, 0],
            [0, radius],
            [-radius, 0],
          ],
        }),
        segmentOfCurve({
          type: 'arc',
          points: [
            [-radius, 0],
            [0, -radius],
            [radius, 0],
          ],
        }),
      ];
      const mapped = mapPieces(base, circle, 1e-6);
      if (isMappingError(mapped)) throw new Error(mapped.error);
      expect(relative(lengthOnFace(base, mapped), 2 * Math.PI * radius)).toBeLessThan(1e-8);
      expect(
        relative(
          circle.reduce((sum, piece) => sum + segmentLength(piece), 0),
          2 * Math.PI * radius,
        ),
      ).toBeLessThan(1e-12);
    }
    const extent = extentOf(mapPieces(base, [{ kind: 'line', from: [-10, 0], to: [10, 0] }], 1e-6) as never);
    expect(extent.max[0] - extent.min[0]).toBeCloseTo(1, 12);
  });

  it('plane: exact images, lengths and the exact 3D curve of a Bezier', () => {
    const chart = chartOf(planeParams, [3, 4, 5], { chart: [3, 4] });
    expect(chart.fullWrapWidth).toBeNull();
    expect(chart.pointAt(chart.uvAt([5, 4]) as Vec2)).toEqual([5, 4, 5]);
    expect(chart.normalAt([0, 0])).toEqual([0, 0, 1]);
    expect(chart.uvOfPoint([7, 8, 5])).toEqual([7, 8]);
    const pieces = [segmentOfOutline({ kind: 'quad', from: [0, 0], control: [5, 5], to: [10, 0] })];
    const mapped = mapPieces(chart, pieces, 1e-6);
    if (isMappingError(mapped)) throw new Error(mapped.error);
    const image = curve3d(chart, mapped, 1e-6);
    if (isMappingError(image)) throw new Error(image.error);
    expect(image.deviation).toBe(0);
    expect(image.curve.poles).toHaveLength(3);
    expect(image.curve.poles[0]).toEqual([0, 0, 5]);
  });

  it('cone: the polar chart keeps lengths (VC-WRP-07: 20 along the generator and a ring r 4 of 25.1327) and fits its pcurves', () => {
    const on: Vec3 = [10, 0, 20];
    const chart = chartOf(coneParams, on, { angleDeg: 90 });
    expect(chart.affine).toBe(false);
    expect(chart.fullWrapWidth).toBeCloseTo(62.8318530718, 8);
    const segment = [{ kind: 'line', from: [-10, 0], to: [10, 0] } as const];
    const mappedLine = mapPieces(chart, segment, 1e-6);
    if (isMappingError(mappedLine)) throw new Error(mappedLine.error);
    expect(relative(lengthOnFace(chart, mappedLine), 20)).toBeLessThan(1e-6);
    const ring = [
      segmentOfCurve({
        type: 'arc',
        points: [
          [4, 0],
          [0, 4],
          [-4, 0],
        ],
      }),
      segmentOfCurve({
        type: 'arc',
        points: [
          [-4, 0],
          [0, -4],
          [4, 0],
        ],
      }),
    ];
    const mappedRing = mapPieces(chart, ring, 1e-6);
    if (isMappingError(mappedRing)) throw new Error(mappedRing.error);
    expect(relative(lengthOnFace(chart, mappedRing), 25.1327412287)).toBeLessThan(1e-6);
    const joined = pcurveOf(mappedRing, 1e-6);
    expect(isMappingError(joined)).toBe(false);
    const image = curve3d(chart, mappedRing, 1e-6);
    if (isMappingError(image)) throw new Error(image.error);
    expect(image.deviation).toBeLessThanOrEqual(1e-6);
    expect(chart.uvOfPoint(chart.pointAt([0.3, 30]))[1]).toBeCloseTo(30, 9);
    expect(chart.normalAt([0, 10])[2]).toBeLessThan(0.5);
    expect(chart.metricBound(5)).toBeGreaterThan(1);
  });

  it('refuses the cone apex as an anchor, and a sketch point that falls on it', () => {
    const atApex = buildFaceChart(coneParams, { anchorChart: [0, 0], anchorOn: [0, 0, 40], angleDeg: 0, mirror: false });
    expect('error' in atApex).toBe(true);
    const chart = chartOf(coneParams, [10, 0, 20]);
    expect(chart.uvAt([0, -Math.hypot(10, 20)])).toBeNull();
    const mapped = mapPieces(chart, [{ kind: 'line', from: [0, -30], to: [0, 0] }], 1e-6);
    expect(isMappingError(mapped)).toBe(true);
  });

  it('spheres, tori and freeform faces have no chart', () => {
    for (const surface of [
      { type: 'sphere', center: [0, 0, 0], radius: 5 },
      { type: 'torus', center: [0, 0, 0], axis: [0, 0, 1], major: 5, minor: 1 },
      { type: 'other', kind: 'bspline' },
    ] as const) {
      const built = buildFaceChart(surface, { anchorChart: [0, 0], anchorOn: [0, 0, 5], angleDeg: 0, mirror: false });
      expect('error' in built && built.error).toBe('not_developable');
    }
  });

  it('a sampler that answers null at a node or between nodes, and a tolerance nothing reaches, are reported', () => {
    expect(isMappingError(fitBySampling((s) => (s === 0 ? null : [s, 0, 0]), 1e-3))).toBe(true);
    expect(isMappingError(fitBySampling((s) => (s > 0.03 && s < 0.04 ? null : [s, s * s, 0]), 1e-3))).toBe(true);
    expect(isMappingError(fitBySampling((s) => [s, Math.sin(40 * s), 0], 1e-30))).toBe(true);
    const chart = chartOf(coneParams, [10, 0, 20]);
    const toApex = mapPieces(chart, [{ kind: 'line', from: [0, -10], to: [0, -Math.hypot(10, 20)] }], 1e-6);
    expect(isMappingError(toApex) && toApex.error).toContain('apex');
  });

  it('the pcurve of a circle joins its fitted arcs, and fails when a rational piece cannot reach the tolerance', () => {
    const chart = chartOf(cylinderParams, [20, 0, 0]);
    const circle = [
      segmentOfCurve({
        type: 'arc',
        points: [
          [4, 0],
          [0, 4],
          [-4, 0],
        ],
      }),
      segmentOfCurve({
        type: 'arc',
        points: [
          [-4, 0],
          [0, -4],
          [4, 0],
        ],
      }),
    ];
    const mapped = mapPieces(chart, circle, 1e-6);
    if (isMappingError(mapped)) throw new Error(mapped.error);
    const joined = pcurveOf(mapped, 1e-6);
    expect(isMappingError(joined)).toBe(false);
    expect(isMappingError(pcurveOf(mapped, 1e-30))).toBe(true);
    const single = pcurveOf([mapped[0] as never], 1e-6);
    expect(isMappingError(single)).toBe(false);
    const line = pcurveOf(
      [
        { kind: 'line', from: [0, 0], to: [1, 1] },
        { kind: 'line', from: [1, 1], to: [2, 0] },
      ],
      1e-6,
    );
    expect(isMappingError(line)).toBe(false);
  });

  it('fits report a curve that cannot be fitted and a zero-length curve', () => {
    expect(isMappingError(fitBySampling(() => [0, 0, 0], 1e-3))).toBe(true);
    const wild = fitBySampling((s) => [s, Math.sin(2000 * s) * 5, 0], 1e-9);
    expect(isMappingError(wild)).toBe(true);
    const fine = fitBySampling((s) => [s, s * s, 0], 1e-6);
    expect(isMappingError(fine)).toBe(false);
  });
});

describe('lib/nurbs/curve2d and geometry/planeSegments', () => {
  it('builds Beziers and arcs, maps them affinely and samples them', () => {
    const bezier = bezier2([
      [0, 0],
      [1, 2],
      [3, 0],
    ]);
    expect(bezier.degree).toBe(2);
    expect(pointAt2(bezier, 0.5)).toEqual([1.25, 1]);
    const arc = arc2([0, 0], 2, 0, Math.PI);
    expect(arc.poles).toHaveLength(5);
    const mid = pointAt2(arc, 0.5);
    expect(Math.hypot(mid[0], mid[1])).toBeCloseTo(2, 12);
    const moved = mapCurve2(arc, ([x, y]) => [x + 1, y]);
    expect(moved.poles[0]).toEqual([3, 0]);
    expect(sample2(bezier, 3)).toHaveLength(3);
    const full = arc2([0, 0], 1, 0, 2 * Math.PI);
    expect(full.poles).toHaveLength(9);
  });

  it('lengths and areas: arcs through three points, both senses, are exact; collinear arcs become lines', () => {
    const ccw = segmentOfCurve({
      type: 'arc',
      points: [
        [1, 0],
        [0, 1],
        [-1, 0],
      ],
    });
    const cw = segmentOfCurve({
      type: 'arc',
      points: [
        [1, 0],
        [0, -1],
        [-1, 0],
      ],
    });
    expect(relative(segmentLength(ccw), Math.PI)).toBeLessThan(1e-12);
    expect(relative(segmentLength(cw), Math.PI)).toBeLessThan(1e-12);
    const close = segmentOfCurve({
      type: 'line',
      points: [
        [-1, 0],
        [1, 0],
      ],
    });
    expect(segmentArea(ccw) + segmentArea(close)).toBeCloseTo(Math.PI / 2, 12);
    expect(segmentArea(cw) + segmentArea(close)).toBeCloseTo(-Math.PI / 2, 12);
    const flat = segmentOfCurve({
      type: 'arc',
      points: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
    });
    expect(flat.kind).toBe('line');
    const bezier = segmentOfCurve({
      type: 'bezier',
      points: [
        [0, 0],
        [1, 1],
        [2, 1],
        [3, 0],
      ],
    });
    expect(bezier.kind).toBe('nurbs');
    const shifted = mapSegment2(bezier, ([x, y]) => [x + 1, y]);
    expect(sampleSegment(shifted, 2)[0]).toEqual([1, 0]);
    const line = segmentOfOutline({ kind: 'line', from: [0, 0], to: [3, 4] });
    expect(segmentLength(line)).toBe(5);
    expect(sampleSegment(line, 3)[1]).toEqual([1.5, 2]);
  });
});

const rectangleLoop = (u0: number, v0: number, u1: number, v1: number): UvLoop => ({
  start: [u0, v0],
  segments: [
    { kind: 'line', to: [u1, v0] },
    { kind: 'line', to: [u1, v1] },
    { kind: 'line', to: [u0, v1] },
    { kind: 'line', to: [u0, v0] },
  ],
});

const node = (
  surface: { type: 'plane' | 'cylinder' | 'cone'; data: number[] },
  regions: UvRegion[],
  mode: 'emboss' | 'deboss' | 'scribe',
  depth: number,
  direction: Vec3,
): Pick<EmbossParams, 'surface' | 'regions' | 'mode' | 'depth' | 'direction'> => ({ surface, regions, mode, depth, direction });

describe('geometry/embossVolume: the closed forms of the pack (VC-WRP-10, 12)', () => {
  const cyl = { type: 'cylinder' as const, data: [0, 0, 0, 0, 0, 1, 1, 0, 0, 20] };

  it('cylinder: A d (1 +- d / 2r) for emboss and deboss, and the opposite signs in a bore', () => {
    const regions: UvRegion[] = [{ outer: rectangleLoop(-0.75, -5, 0.75, 5), holes: [] }];
    expect(embossClosedForm(node(cyl, regions, 'emboss', 1, [1, 0, 0]))?.delta).toBeCloseTo(307.5, 9);
    expect(embossClosedForm(node(cyl, regions, 'deboss', 1, [1, 0, 0]))?.delta).toBeCloseTo(-292.5, 9);
    expect(embossClosedForm(node(cyl, regions, 'deboss', 1, [-1, 0, 0]))?.delta).toBeCloseTo(-307.5, 9);
    expect(embossClosedForm(node(cyl, regions, 'emboss', 1, [-1, 0, 0]))?.delta).toBeCloseTo(292.5, 9);
    expect(embossClosedForm(node(cyl, regions, 'scribe', 0, [1, 0, 0]))).toEqual({ area: 300, delta: 0, convex: true });
    expect(regionsAreas(regions).uv).toBeCloseTo(15, 12);
  });

  it('holes subtract their area; planes follow A d', () => {
    const regions: UvRegion[] = [{ outer: rectangleLoop(0, 0, 4, 3), holes: [rectangleLoop(1, 1, 2, 2)] }];
    const flat = { type: 'plane' as const, data: [0, 0, 0, 1, 0, 0, 0, 1, 0] };
    expect(embossClosedForm(node(flat, regions, 'emboss', 2, [0, 0, 1]))?.delta).toBeCloseTo(22, 12);
    expect(embossClosedForm(node(flat, regions, 'deboss', 2, [0, 0, 1]))?.delta).toBeCloseTo(-22, 12);
    expect(regionsAreas(regions).uv).toBeCloseTo(11, 12);
  });

  it('cone: a chart sector 0.5 rad, slant 15..35 gives 260 and the full band 1461.16146 (Steiner)', () => {
    const alpha = Math.atan2(20, 40);
    const coneNode = { type: 'cone' as const, data: [0, 0, 40, 0, 0, -1, 1, 0, 0, alpha] };
    const sector: UvRegion[] = [{ outer: rectangleLoop(-0.25 / Math.sin(alpha), 15, 0.25 / Math.sin(alpha), 35), holes: [] }];
    const direction: Vec3 = [Math.cos(alpha), 0, Math.sin(alpha)];
    const sectorForm = embossClosedForm(node(coneNode, sector, 'emboss', 1, direction));
    expect(relative(sectorForm?.delta as number, 260)).toBeLessThan(1e-9);
    expect(relative(sectorForm?.area as number, 250)).toBeLessThan(1e-9);
    const band: UvRegion[] = [{ outer: rectangleLoop(-Math.PI, 15, Math.PI, 35), holes: [] }];
    expect(
      relative(embossClosedForm(node(coneNode, band, 'emboss', 1, [-direction[0], 0, direction[2]]))?.delta as number, 1461.16146406),
    ).toBeLessThan(1e-9);
    expect(embossClosedForm(node(coneNode, sector, 'deboss', 1, direction))?.delta).toBeCloseTo(-240, 9);
    expect(embossClosedForm(node(coneNode, sector, 'emboss', 1, [-direction[0], 0, -direction[2]]))?.delta).toBeCloseTo(240, 9);
  });

  it('refuses nodes without regions and surfaces it does not know', () => {
    expect(embossClosedForm(node(cyl, [], 'emboss', 1, [1, 0, 0]))).toBeNull();
    expect(
      embossClosedForm(
        node({ type: 'sphere' as never, data: [] }, [{ outer: rectangleLoop(0, 0, 1, 1), holes: [] }], 'emboss', 1, [1, 0, 0]),
      ),
    ).toBeNull();
  });
});
