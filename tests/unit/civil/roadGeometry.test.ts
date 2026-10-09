import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@core/model/types';
import {
  alignmentLength,
  centrelinePoints,
  horizontalElements,
  pointAtStation,
  sampleStations,
  stationOffset,
  validateHorizontal,
  type ArcElement,
} from '@aec/civil/alignmentGeometry';
import {
  designElevation,
  grades,
  validateProfile,
  verticalCurves,
  verticalCurveStations,
} from '@aec/civil/profileGeometry';

const corner: { points: Vec2[]; radii: number[]; startStation: number } = {
  points: [
    [0, 0],
    [100, 0],
    [100, 100],
  ],
  radii: [30],
  startStation: 1000,
};

describe('horizontal geometry', () => {
  const elements = horizontalElements(corner);

  it('builds line - arc - line with R*delta curve length and R*tan(delta/2) tangents', () => {
    expect(elements.map((e) => e.kind)).toEqual(['line', 'arc', 'line']);
    const arc = elements[1] as ArcElement;
    expect(arc.length).toBeCloseTo(30 * (Math.PI / 2), 9);
    expect(arc.deflection).toBeCloseTo(Math.PI / 2, 9);
    expect(arc.rotation).toBe('ccw');
    expect(arc.start[0]).toBeCloseTo(70, 9);
    expect(arc.end[1]).toBeCloseTo(30, 9);
    expect(arc.center[0]).toBeCloseTo(70, 9);
    expect(arc.center[1]).toBeCloseTo(30, 9);
    expect(arc.startStation).toBeCloseTo(1070, 9);
    expect(alignmentLength(corner)).toBeCloseTo(140 + 15 * Math.PI, 9);
  });

  it('turns clockwise for a right-hand deflection', () => {
    const right = horizontalElements({
      ...corner,
      points: [
        [0, 0],
        [100, 0],
        [100, -100],
      ],
    });
    expect((right[1] as ArcElement).rotation).toBe('cw');
    const mid = pointAtStation(
      {
        ...corner,
        points: [
          [0, 0],
          [100, 0],
          [100, -100],
        ],
      },
      1070 + (15 * Math.PI) / 2,
    );
    expect(mid?.point[0]).toBeCloseTo(70 + 30 * Math.sin(Math.PI / 4), 6);
    expect(mid?.point[1]).toBeCloseTo(-(30 - 30 * Math.cos(Math.PI / 4)), 6);
  });

  it('keeps a sharp corner for radius 0 and merges collinear PIs', () => {
    const sharp = horizontalElements({ ...corner, radii: [0] });
    expect(sharp.map((e) => e.kind)).toEqual(['line', 'line']);
    const straight = horizontalElements({
      points: [
        [0, 0],
        [50, 0],
        [100, 0],
      ],
      radii: [25],
      startStation: 0,
    });
    expect(straight.map((e) => e.kind)).toEqual(['line', 'line']);
  });

  it('round-trips station -> point -> station on the arc, with signed offsets', () => {
    const station = 1070 + 20;
    const placed = pointAtStation(corner, station);
    expect(placed).not.toBeNull();
    const back = stationOffset(corner, placed?.point as Vec2);
    expect(back?.station).toBeCloseTo(station, 6);
    expect(back?.offset).toBeCloseTo(0, 6);
    const inside = stationOffset(corner, [70, 30]);
    expect(inside?.offset).toBeCloseTo(30, 6);
    const outside = stationOffset(corner, [
      70 + 38 * Math.cos(-Math.PI / 4),
      30 + 38 * Math.sin(-Math.PI / 4),
    ]);
    expect(outside?.offset).toBeCloseTo(-8, 6);
  });

  it('clamps stations and finds points beyond the ends and before the arc', () => {
    expect(pointAtStation(corner, -5000)?.point).toEqual([0, 0]);
    expect(pointAtStation(corner, 9999)?.point[1]).toBeCloseTo(100, 9);
    const before = stationOffset(corner, [30, 5]);
    expect(before?.station).toBeCloseTo(1000, 9);
    expect(before?.offset).toBeCloseTo(5, 9);
    const nearEnd = stationOffset(corner, [100, 150]);
    expect(nearEnd?.station).toBeCloseTo(1000 + alignmentLength(corner), 6);
    const wide = stationOffset(corner, [-40, 80]);
    expect(wide?.distance).toBeGreaterThan(0);
    const exact = stationOffset(corner, [0, 0]);
    expect(exact?.offset).toBe(0);
  });

  it('reports invalid geometry with the offending PI and returns no elements', () => {
    expect(validateHorizontal([[0, 0]], [])).toMatch(/at least 2/);
    expect(
      validateHorizontal(
        [
          [0, 0],
          [Number.NaN, 1],
        ],
        [],
      ),
    ).toMatch(/finite/);
    expect(
      validateHorizontal(
        [
          [0, 0],
          [0, 0],
        ],
        [],
      ),
    ).toMatch(/coincide/);
    expect(
      validateHorizontal(
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        [],
      ),
    ).toMatch(/radii needs 1/);
    expect(
      validateHorizontal(
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        [-1],
      ),
    ).toMatch(/radii must/);
    expect(
      validateHorizontal(
        [
          [0, 0],
          [10, 0],
          [0, 0.0000001],
        ],
        [1],
      ),
    ).toMatch(/doubles back/);
    const tight = [
      [0, 0],
      [50, 0],
      [50, 50],
      [100, 50],
    ] as Vec2[];
    const message = validateHorizontal(tight, [30, 30]);
    expect(message).toMatch(/PI 1/);
    expect(horizontalElements({ points: tight, radii: [30, 30], startStation: 0 })).toEqual([]);
    expect(pointAtStation({ points: tight, radii: [30, 30], startStation: 0 }, 5)).toBeNull();
    expect(stationOffset({ points: tight, radii: [30, 30], startStation: 0 }, [0, 0])).toBeNull();
    expect(validateHorizontal(tight, [20, 20])).toBeNull();
    expect(validateHorizontal(tight, [0, 60])).toMatch(/PI 2/);
  });

  it('samples stations with PC / PT and densified arcs; caps the count', () => {
    const stations = sampleStations(corner, 50);
    expect(stations[0]).toBe(1000);
    expect(stations).toContain(1070);
    expect(stations.some((s) => Math.abs(s - (1070 + 15 * Math.PI)) < 1e-9)).toBe(true);
    const arcStations = stations.filter((s) => s > 1070 && s < 1070 + 15 * Math.PI);
    expect(arcStations.length).toBeGreaterThanOrEqual(17);
    expect(sampleStations(corner, 50, [1100, 5000])).toContain(1100);
    expect(sampleStations(corner, 0.001).length).toBeLessThan(2400);
    expect(sampleStations({ points: [[0, 0]], radii: [], startStation: 0 }, 10)).toEqual([]);
    expect(centrelinePoints(corner).length).toBeGreaterThan(18);
  });
});

describe('vertical geometry', () => {
  const profile = [
    { station: 0, elevation: 100, curveLength: 0 },
    { station: 100, elevation: 102, curveLength: 40 },
    { station: 200, elevation: 101, curveLength: 0 },
  ];

  it('evaluates tangents and the parabola analytically', () => {
    expect(grades(profile)).toEqual([0.02, -0.01]);
    expect(designElevation(profile, 50)).toBeCloseTo(101, 9);
    expect(designElevation(profile, 150)).toBeCloseTo(101.5, 9);
    expect(designElevation(profile, 100)).toBeCloseTo(101.85, 9);
    expect(designElevation(profile, 80)).toBeCloseTo(101.6, 9);
    expect(designElevation(profile, 120)).toBeCloseTo(101.8, 9);
    expect(designElevation(profile, 0)).toBe(100);
    expect(designElevation(profile, -1)).toBeNull();
    expect(designElevation(profile, 201)).toBeNull();
    expect(designElevation([], 5)).toBeNull();
  });

  it('computes K, kind and the high point of a crest', () => {
    const [curve] = verticalCurves(profile);
    expect(curve?.kind).toBe('crest');
    expect(curve?.k).toBeCloseTo(40 / 3, 9);
    expect(curve?.turning?.station).toBeCloseTo(80 + 80 / 3, 9);
    expect(curve?.turning?.elevation).toBeCloseTo(101.8667, 3);
    const sag = verticalCurves([
      { station: 0, elevation: 100, curveLength: 0 },
      { station: 100, elevation: 99, curveLength: 60 },
      { station: 200, elevation: 101, curveLength: 0 },
    ]);
    expect(sag[0]?.kind).toBe('sag');
    expect(sag[0]?.turning?.elevation).toBeLessThan(99.2);
    const noTurn = verticalCurves([
      { station: 0, elevation: 100, curveLength: 0 },
      { station: 100, elevation: 101, curveLength: 20 },
      { station: 200, elevation: 103, curveLength: 0 },
    ]);
    expect(noTurn[0]?.turning).toBeNull();
    expect(
      verticalCurves([
        { station: 0, elevation: 1, curveLength: 0 },
        { station: 10, elevation: 2, curveLength: 0 },
        { station: 20, elevation: 3, curveLength: 5 },
      ]),
    ).toEqual([]);
    expect(verticalCurveStations(profile)).toHaveLength(9);
  });

  it('validates stations, lengths and overlapping curves', () => {
    const pvi = (station: number, curveLength = 0) => ({ station, elevation: 0, curveLength });
    expect(validateProfile([pvi(0)])).toMatch(/at least 2/);
    expect(
      validateProfile([pvi(0), { station: Number.NaN, elevation: 0, curveLength: 0 }]),
    ).toMatch(/finite/);
    expect(validateProfile([pvi(0), pvi(5, -1), pvi(10)])).toMatch(/curveLength/);
    expect(validateProfile([pvi(0), pvi(0)])).toMatch(/increase/);
    expect(validateProfile([pvi(0, 10), pvi(10)])).toMatch(/first and last/);
    expect(validateProfile([pvi(0), pvi(10, 12), pvi(20, 12), pvi(30)])).toMatch(/overlap/);
    expect(validateProfile([pvi(0), pvi(10, 10), pvi(20, 10), pvi(30)])).toBeNull();
  });
});
