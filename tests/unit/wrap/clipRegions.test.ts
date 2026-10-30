/**
 * 03 WRP M5 (multi-face wraps): half-plane clipping of chart regions and chains. Every area is a closed form of the polygon / circle, the pieces are exact (lines cut, Bezier and
 * rational arcs split by knot insertion), and a region cut by the line is closed by a chord, so the kept and the dropped parts add up to the region.
 */

import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@core/model/vectors';
import { arc2, bezier2 } from '@core/lib/nurbs/curve2d';
import { segmentArea, segmentEnd, segmentStart, type PlaneSegment } from '@core/geometry/planeSegments';
import { clipChains, clipRegions, type HalfPlane } from '@core/commands/wrap/clipRegions';
import type { ChartRegion } from '@core/commands/wrap/sketchProfiles';

const polygon = (points: Vec2[]): PlaneSegment[] =>
  points.map((from, k) => ({ kind: 'line' as const, from, to: points[(k + 1) % points.length] as Vec2 }));
const ccw = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const loopArea = (loop: readonly PlaneSegment[]): number => loop.reduce((sum, segment) => sum + segmentArea(segment), 0);
const regionArea = (region: ChartRegion): number =>
  Math.abs(loopArea(region.outer)) - region.holes.reduce((sum, hole) => sum + Math.abs(loopArea(hole)), 0);
const total = (regions: readonly ChartRegion[] | null): number => (regions ?? []).reduce((sum, region) => sum + regionArea(region), 0);
const right = (x: number): HalfPlane => ({ point: [x, 0], normal: [1, 0] });
const left = (x: number): HalfPlane => ({ point: [x, 0], normal: [-1, 0] });
const closed = (loop: readonly PlaneSegment[]): boolean =>
  loop.every((segment, k) => {
    const next = segmentStart(loop[(k + 1) % loop.length] as PlaneSegment);
    const end = segmentEnd(segment);
    return Math.hypot(end[0] - next[0], end[1] - next[1]) < 1e-9;
  });

describe('clipRegions', () => {
  const square: ChartRegion = { outer: polygon(ccw(0, 0, 10, 10)), holes: [] };

  it('cuts a square by a vertical line: 60 and 40 square units, one closed loop each, and the parts add up', () => {
    const keep = clipRegions([square], right(4)) as ChartRegion[];
    const drop = clipRegions([square], left(4)) as ChartRegion[];
    expect(keep).toHaveLength(1);
    expect(regionArea(keep[0] as ChartRegion)).toBeCloseTo(60, 9);
    expect(total(drop)).toBeCloseTo(40, 9);
    expect(closed(keep[0]?.outer as PlaneSegment[])).toBe(true);
    expect(total(keep) + total(drop)).toBeCloseTo(100, 9);
  });

  it('keeps a region on the kept side as it is and drops a region on the other side', () => {
    expect(clipRegions([square], right(-5))).toEqual([square]);
    expect(clipRegions([square], right(15))).toEqual([]);
  });

  it('a hole cut by the line becomes part of the boundary (area 50 - 8), a hole on the kept side stays a hole, a hole on the dropped side vanishes', () => {
    const hole = polygon([...ccw(3, 3, 7, 7)].reverse());
    const holed: ChartRegion = { outer: polygon(ccw(0, 0, 10, 10)), holes: [hole] };
    const cutHole = clipRegions([holed], right(5)) as ChartRegion[];
    expect(cutHole).toHaveLength(1);
    expect(cutHole[0]?.holes).toHaveLength(0);
    expect(total(cutHole)).toBeCloseTo(42, 9);
    const keptHole = clipRegions([holed], right(1)) as ChartRegion[];
    expect(keptHole[0]?.holes).toHaveLength(1);
    expect(total(keptHole)).toBeCloseTo(90 - 16, 9);
    const goneHole = clipRegions([holed], right(8)) as ChartRegion[];
    expect(goneHole[0]?.holes).toHaveLength(0);
    expect(total(goneHole)).toBeCloseTo(20, 9);
    expect(total(clipRegions([holed], right(5))) + total(clipRegions([holed], left(5)))).toBeCloseTo(84, 9);
  });

  it('a U shape cut across both arms gives two regions', () => {
    const u: ChartRegion = {
      outer: polygon([
        [0, 0],
        [9, 0],
        [9, 10],
        [6, 10],
        [6, 3],
        [3, 3],
        [3, 10],
        [0, 10],
      ]),
      holes: [],
    };
    const arms = clipRegions([u], { point: [0, 5], normal: [0, 1] }) as ChartRegion[];
    expect(arms).toHaveLength(2);
    expect(total(arms)).toBeCloseTo(3 * 5 + 3 * 5, 9);
    const base = clipRegions([u], { point: [0, 5], normal: [0, -1] }) as ChartRegion[];
    expect(base).toHaveLength(1);
    expect(total(base)).toBeCloseTo(9 * 5 - 3 * 2, 9);
  });

  it('cuts a circle (rational NURBS) in half exactly: the area is pi r^2 / 2 and the parts add up', () => {
    const circle: PlaneSegment = { kind: 'nurbs', curve: arc2([0, 0], 5, 0, 2 * Math.PI) };
    const disc: ChartRegion = { outer: [circle], holes: [] };
    const half = clipRegions([disc], right(0)) as ChartRegion[];
    expect(total(half)).toBeCloseTo((Math.PI * 25) / 2, 8);
    const part = clipRegions([disc], right(3)) as ChartRegion[];
    const rest = clipRegions([disc], left(3)) as ChartRegion[];
    expect(total(part) + total(rest)).toBeCloseTo(Math.PI * 25, 8);
    const segment = 25 * Math.acos(3 / 5) - 3 * 4;
    expect(total(part)).toBeCloseTo(segment, 8);
    expect(closed(half[0]?.outer as PlaneSegment[])).toBe(true);
  });

  it('a boundary vertex exactly on the line is one crossing: a square -1..1 with a degree-1 NURBS bottom is cut in 2 + 2', () => {
    const bottom: PlaneSegment = {
      kind: 'nurbs',
      curve: bezier2([
        [-1, -1],
        [1, -1],
      ]),
    };
    const square2: ChartRegion = {
      outer: [
        bottom,
        { kind: 'line', from: [1, -1], to: [1, 1] },
        { kind: 'line', from: [1, 1], to: [-1, 1] },
        { kind: 'line', from: [-1, 1], to: [-1, -1] },
      ],
      holes: [],
    };
    const keep = clipRegions([square2], right(0)) as ChartRegion[];
    const drop = clipRegions([square2], left(0)) as ChartRegion[];
    expect(total(keep)).toBeCloseTo(2, 9);
    expect(total(drop)).toBeCloseTo(2, 9);
    expect(keep).toHaveLength(1);
  });

  it('an edge lying ON the line belongs to the kept side: the square [0, 10]^2 clipped by x >= 0 comes back untouched (the same loop)', () => {
    const kept = clipRegions([square], right(0)) as ChartRegion[];
    expect(kept).toHaveLength(1);
    expect(total(kept)).toBeCloseTo(100, 9);
    expect(kept[0]?.outer).toBe(square.outer);
  });

  it('refuses boundaries whose crossings do not pair into chords (a hole wound like its outer)', () => {
    const wrong: ChartRegion = { outer: polygon(ccw(0, 0, 10, 10)), holes: [polygon(ccw(3, 3, 7, 7))] };
    expect(clipRegions([wrong], right(5))).toBeNull();
  });
});

describe('clipChains', () => {
  it('keeps the runs on the kept side of open chains and of loops, and a loop entirely kept stays closed', () => {
    const line: PlaneSegment[] = [{ kind: 'line', from: [0, 0], to: [10, 0] }];
    const kept = clipChains([{ segments: line, closed: false }], right(4));
    expect(kept).toHaveLength(1);
    expect(segmentStart(kept[0]?.segments[0] as PlaneSegment)[0]).toBeCloseTo(4, 12);
    const loop = polygon(ccw(0, 0, 10, 10));
    const cutLoop = clipChains([{ segments: loop, closed: true }], right(4));
    expect(cutLoop).toHaveLength(1);
    expect(cutLoop[0]?.closed).toBe(false);
    expect(
      cutLoop[0]?.segments.reduce(
        (sum, s) => sum + Math.hypot(segmentEnd(s)[0] - segmentStart(s)[0], segmentEnd(s)[1] - segmentStart(s)[1]),
        0,
      ),
    ).toBeCloseTo(6 + 10 + 6, 9);
    expect(clipChains([{ segments: loop, closed: true }], right(-1))[0]?.closed).toBe(true);
    expect(clipChains([{ segments: loop, closed: true }], right(11))).toEqual([]);
  });
});
