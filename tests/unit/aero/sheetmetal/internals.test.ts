import { describe, expect, it } from 'vitest';
import type { Entity, Vec2 } from '@core/model/types';
import type { ShapeEdge } from '@core/geometry/kernel';
import type { BendRadiusRow, SheetMetalRule } from '@core/model/sheetMetal';
import { clipHalfPlane, lineCrossings, moveEdgeInward, polygonToSegmentDistance, segmentDistance } from '@aero/sheetmetal/geometry2d';
import { mergePolygons } from '@aero/sheetmetal/outline';
import { bendEnd, notchOutline } from '@aero/sheetmetal/reliefGeometry';
import { findRadiusRow, resolveK, ruleUnverifiedInputs } from '@aero/sheetmetal/rules';
import { readProfile } from '@aero/sheetmetal/profile';
import { chainLoop } from '@aero/sheetmetal/convert/faces';
import { recogniseJoggles } from '@aero/sheetmetal/convert/joggles';
import { estimateThickness } from '@aero/sheetmetal/convert/graph';

const square = (x: number, y: number, size = 10): Vec2[] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];

describe('planar helpers', () => {
  it('moves an edge inward and refuses a move past the opposite side or between parallel neighbours', () => {
    expect(moveEdgeInward(square(0, 0), 1, 2)?.map((p) => p[0])).toEqual([0, 8, 8, 0]);
    expect(moveEdgeInward(square(0, 0), 1, 20)).toBeNull();
    const parallel: Vec2[] = [
      [0, 0],
      [10, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ];
    expect(moveEdgeInward(parallel, 1, 1)).toBeNull();
  });

  it('measures segment and polygon distances', () => {
    expect(segmentDistance([0, 0], [10, 0], [5, -1], [5, 1])).toBe(0);
    expect(segmentDistance([0, 0], [10, 0], [0, 3], [10, 3])).toBeCloseTo(3, 12);
    expect(polygonToSegmentDistance(square(0, 0), [20, 0], [20, 10])).toBeCloseTo(10, 12);
  });

  it('clips to both half planes and finds line crossings in order', () => {
    expect(clipHalfPlane(square(0, 0), [5, 0], [1, 0], 'positive').map((p) => p[0])).toEqual(expect.arrayContaining([5, 10]));
    expect(clipHalfPlane(square(0, 0), [5, 0], [1, 0], 'negative').every((p) => p[0] <= 5)).toBe(true);
    expect(lineCrossings(square(0, 0), [5, 5], [0, 1])).toEqual([
      [5, 0],
      [5, 10],
    ]);
    expect(lineCrossings(square(0, 0), [50, 5], [0, 1])).toEqual([]);
  });
});

describe('mergePolygons', () => {
  it('merges edge-adjacent rectangles (partial overlap included) into one outline', () => {
    const merged = mergePolygons([
      square(0, 0),
      [
        [10, 2],
        [20, 2],
        [20, 8],
        [10, 8],
      ],
    ]);
    expect(merged?.outer).toHaveLength(8);
    expect(merged?.holes).toEqual([]);
  });

  it('keeps the hole of a ring of rectangles and returns null for nothing or an inside-out input', () => {
    const ring = mergePolygons([
      [
        [0, 0],
        [30, 0],
        [30, 10],
        [0, 10],
      ],
      [
        [0, 20],
        [30, 20],
        [30, 30],
        [0, 30],
      ],
      [
        [0, 10],
        [10, 10],
        [10, 20],
        [0, 20],
      ],
      [
        [20, 10],
        [30, 10],
        [30, 20],
        [20, 20],
      ],
    ]);
    expect(ring?.outer).toHaveLength(4);
    expect(ring?.holes).toHaveLength(1);
    expect(mergePolygons([])).toBeNull();
    expect(
      mergePolygons([
        [
          [0, 0],
          [0, 10],
          [10, 10],
          [10, 0],
        ],
      ]),
    ).toBeNull();
  });
});

describe('relief notches', () => {
  const outline = square(0, 0, 20);
  const line: [Vec2, Vec2] = [
    [20, 15],
    [20, 5],
  ];

  it('locates the free stretch beyond each end of a bend line', () => {
    const start = bendEnd(outline, line, 'start');
    const end = bendEnd(outline, line, 'end');
    expect(start?.free).toBeCloseTo(5, 9);
    expect(end?.free).toBeCloseTo(5, 9);
    expect(
      bendEnd(
        outline,
        [
          [5, 5],
          [5, 10],
        ],
        'start',
      ),
    ).toBeNull();
    expect(
      bendEnd(
        outline,
        [
          [20, 5],
          [20, 15],
        ],
        'start',
      ),
    ).toBeNull();
  });

  it('cuts interior and corner-touching notches and refuses impossible ones', () => {
    const end = bendEnd(outline, line, 'end');
    const start = bendEnd(outline, line, 'start');
    expect(notchOutline(outline, end!, 'end', 2, 3)).toHaveLength(8);
    expect(notchOutline(outline, end!, 'end', 5, 3)).toHaveLength(6);
    expect(notchOutline(outline, start!, 'start', 5, 3)).toHaveLength(6);
    expect(notchOutline(outline, end!, 'end', 6, 3)).toBeNull();
    expect(notchOutline(outline, end!, 'end', 5, 30)).toBeNull();
    const whole = bendEnd(
      outline,
      [
        [20, 20],
        [20, 0],
      ],
      'start',
    );
    expect(notchOutline(outline, whole!, 'start', 5, 3)).toBeNull();
    const slanted: Vec2[] = [
      [0, 5],
      [20, 0],
      [20, 20],
      [0, 20],
    ];
    const slantedEnd = bendEnd(slanted, line, 'end');
    expect(notchOutline(slanted, slantedEnd!, 'end', 5, 3)).toBeNull();
    const shortSide: Vec2[] = [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ];
    const near = bendEnd(
      shortSide,
      [
        [20, 20],
        [20, 5],
      ],
      'end',
    );
    expect(notchOutline(shortSide, near!, 'end', 5, 25)).toBeNull();
  });
});

describe('rules', () => {
  const base: SheetMetalRule = {
    name: 'r',
    material: 'm',
    temper: 't',
    thickness: 2,
    insideRadius: 2,
    k: { standard: 'ansi', value: 0.4 },
  };

  it('resolves K from an override, a value, a DIN value and a DIN table', () => {
    expect(resolveK(base, 2, 0.33)).toMatchObject({ value: 0.33, source: 'bend override' });
    expect(resolveK(base, 2).value).toBe(0.4);
    expect(resolveK({ ...base, k: { standard: 'din', value: 0.8 } }, 2).value).toBeCloseTo(0.4, 12);
    const table = resolveK(
      {
        ...base,
        k: {
          standard: 'din',
          table: [
            { rOverT: 1, k: 0.8 },
            { rOverT: 3, k: 0.9 },
          ],
          source: 's',
          verification: 'unverified',
        },
      },
      4,
    );
    expect(table).toMatchObject({ verification: 'unverified' });
    expect(table.value).toBeCloseTo(0.425, 12);
  });

  it('matches radius rows by material, temper, thickness (any unit) and nearest angle', () => {
    const rows: BendRadiusRow[] = [
      { material: 'm', temper: 't', thickness: 2, minInsideRadius: 3, units: 'mm', bendAngle: 90, source: 'a', verification: 'verified' },
      {
        material: 'm',
        temper: 't',
        thickness: 2,
        minInsideRadius: 5,
        units: 'mm',
        bendAngle: 180,
        source: 'b',
        verification: 'unverified',
      },
      {
        material: 'm',
        temper: 't',
        thickness: 2 / 25.4,
        minInsideRadius: 1 / 25.4,
        units: 'in',
        bendAngle: 45,
        source: 'c',
        verification: 'verified',
      },
    ];
    const query = { material: 'm', temper: 't', thickness: 2, unit: 'mm' as const };
    expect(findRadiusRow(rows, { ...query, angleDeg: 170 })?.row.source).toBe('b');
    expect(findRadiusRow(rows, { ...query, angleDeg: 50 })?.minInsideRadius).toBeCloseTo(1, 9);
    expect(findRadiusRow(rows, { ...query, temper: undefined, angleDeg: 90 })).toBeUndefined();
    expect(findRadiusRow(rows, { ...query, thickness: 3, angleDeg: 90 })).toBeUndefined();
  });

  it('collects unverified tables, rows and thresholds once', () => {
    const rule: SheetMetalRule = {
      ...base,
      k: { standard: 'ansi', table: [{ rOverT: 1, k: 0.4 }], source: 'chart', verification: 'unverified' },
      thresholds: {
        minFlange: { value: 3, source: 'rule', verification: 'unverified' },
        holeToEdge: { value: 3, source: 'ok', verification: 'verified' },
      },
    };
    const model = {
      rules: {},
      parts: {},
      radiusTable: [
        {
          material: 'm',
          temper: 't',
          thickness: 2,
          minInsideRadius: 3,
          units: 'mm' as const,
          bendAngle: 90,
          source: 'row',
          verification: 'unverified' as const,
        },
      ],
    };
    expect(ruleUnverifiedInputs(model, rule, 'mm').map((input) => input.kind)).toEqual(['k_table', 'radius_row', 'preset']);
    const { temper: _temper, ...withoutTemper } = base;
    void _temper;
    expect(ruleUnverifiedInputs(model, withoutTemper, 'mm')).toEqual([]);
  });
});

describe('profiles', () => {
  const entity = (fields: Record<string, unknown>): Entity =>
    ({
      id: 'e',
      position: [1, 2, 3],
      rotation: [0, 0, Math.PI / 2],
      layerId: 'layer-default',
      color: '#000',
      ...fields,
    }) as unknown as Entity;

  it('reads rectangles, circles and closed polylines with the frame of their plane', () => {
    const rectangle = readProfile(entity({ kind: 'rectangle', width: 4, height: 2 }));
    expect(typeof rectangle).toBe('object');
    if (typeof rectangle === 'string') return;
    expect(rectangle.frame.origin).toEqual([1, 2, 3]);
    expect(rectangle.frame.xDir[1]).toBeCloseTo(1, 12);
    expect(rectangle.points).toHaveLength(4);
    const circle = readProfile(entity({ kind: 'circle', center: [1, 1], radius: 2 }));
    expect(typeof circle === 'object' && circle.circle).toEqual({ center: [1, 1], radius: 2 });
    const clockwise = readProfile(
      entity({
        kind: 'polyline',
        closed: true,
        points: [
          [0, 0],
          [0, 5],
          [5, 5],
          [5, 0],
        ],
      }),
    );
    expect(typeof clockwise === 'object' && clockwise.points[1]).toEqual([5, 5]);
  });

  it('describes why a shape is refused', () => {
    expect(readProfile(entity({ kind: 'rectangle', width: 0, height: 2 }))).toContain('no area');
    expect(readProfile(entity({ kind: 'circle', center: [0, 0], radius: 0 }))).toContain('no area');
    expect(
      readProfile(
        entity({
          kind: 'polyline',
          closed: false,
          points: [
            [0, 0],
            [1, 1],
          ],
        }),
      ),
    ).toContain('open');
    expect(
      readProfile(
        entity({
          kind: 'polyline',
          closed: true,
          points: [
            [0, 0],
            [10, 10],
            [10, 0],
            [0, 10],
          ],
        }),
      ),
    ).toContain('self-intersecting');
    expect(readProfile(entity({ kind: 'line', start: [0, 0], end: [1, 1] }))).toContain('use a rectangle');
    expect(readProfile(entity({ kind: 'box', size: [1, 1, 1] }))).toContain('not a 2D profile');
  });
});

describe('conversion helpers', () => {
  it('chains unordered edges into a closed loop and rejects open ones', () => {
    const edge = (a: [number, number, number], b: [number, number, number]): ShapeEdge => ({
      index: 0,
      curve: 'line' as const,
      length: 1,
      start: a,
      end: b,
      mid: a,
      seam: false,
      degenerate: false,
    });
    const loop = chainLoop(
      [edge([0, 0, 0], [1, 0, 0]), edge([0, 1, 0], [0, 0, 0]), edge([1, 1, 0], [0, 1, 0]), edge([1, 0, 0], [1, 1, 0])],
      1e-9,
    );
    expect(loop?.points).toHaveLength(4);
    expect(chainLoop([edge([0, 0, 0], [1, 0, 0]), edge([5, 5, 0], [6, 5, 0])], 1e-9)).toBeNull();
    expect(chainLoop([edge([0, 0, 0], [1, 0, 0]), edge([1, 0, 0], [2, 0, 0])], 1e-9)).toBeNull();
    expect(chainLoop([], 1e-9)).toBeNull();
  });

  it('finds no thickness in an empty solid and no joggle in a single bend', () => {
    expect(
      estimateThickness({
        graph: { faces: [], edgeFaces: [], edgeConvexity: [] },
        edges: [],
        volume: 0,
        planes: new Map(),
        cylinders: new Map(),
        other: [],
      }),
    ).toBeNull();
    expect(recogniseJoggles([], 1)).toEqual([]);
  });
});
