import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import {
  snapPerpendicular,
  tangentPointsToCircle,
  snapTangentToCircle,
  snapExtension,
  nearestOnSegment,
  nearestOnArc,
  isAngleOnArc,
  entityToSegments,
  localToWorld2D,
} from '../../src/ui/viewport/2d/snapping/geometry';
import { snap, applyOrthoPolar } from '../../src/ui/viewport/2d/snapping/resolveSnap';
import { collectSnapCandidates } from '../../src/ui/viewport/2d/snapping/candidates';
import { docWith } from '../helpers/fixtureDocument';
import { xy } from '../helpers/xy';
import {
  curveCurveIntersections,
  segmentCurveIntersections,
  type CircularCurve,
} from '../../src/ui/viewport/2d/snapping/curveIntersections';

type SnapType = Parameters<typeof snap>[1][number]['type'];
const line = (start: number[], end: number[], extra: object = {}): Record<string, unknown> => ({
  id: `l${String(start)}`,
  kind: 'line',
  start,
  end,
  ...extra,
});
const circle = (center: number[], radius: number): Record<string, unknown> => ({ id: 'c1', kind: 'circle', center, radius });
const arc = (startAngle: number, endAngle: number): Record<string, unknown> => ({
  id: 'a1',
  kind: 'arc',
  center: [0, 0],
  radius: 5,
  startAngle,
  endAngle,
});
const LINE = docWith(line([0, 0], [10, 0]));
const of = (doc: CadDocument, type: string, ...args: unknown[]): Array<{ x: number; y: number; type: string }> =>
  (collectSnapCandidates as (...a: unknown[]) => Array<{ x: number; y: number; type: string }>)(doc, ...args).filter(
    (c) => c.type === type,
  );
const near = (x: number, y: number): unknown => expect.objectContaining({ x: expect.closeTo(x, 6), y: expect.closeTo(y, 6) });
const close2 = (p: readonly number[] | null | undefined, x: number, y: number): void => {
  expect(p![0]).toBeCloseTo(x);
  expect(p![1]).toBeCloseTo(y);
};

describe('collectSnapCandidates', () => {
  it.each<[string, CadDocument, Record<string, Array<[number, number]>>]>([
    ['line', LINE, { endpoint: xy(0, 0, 10, 0), midpoint: xy(5, 0) }],
    ['circle', docWith(circle([5, 5], 3)), { center: xy(5, 5), endpoint: xy(8, 5, 2, 5, 5, 8, 5, 2) }],
    [
      'rectangle',
      docWith({ id: 'r1', kind: 'rectangle', width: 10, height: 4 }),
      { endpoint: xy(0, 0, 10, 0, 10, 4, 0, 4), center: xy(5, 2) },
    ],
    ['crossing lines', docWith(line([0, -5], [0, 5]), line([-5, 0], [5, 0])), { intersection: xy(0, 0) }],
    ['offset line', docWith(line([0, 0], [1, 0], { position: [5, 10, 0] })), { endpoint: xy(5, 10, 6, 10) }],
    ['arc', docWith(arc(0, Math.PI)), { center: xy(0, 0), endpoint: xy(5, 0, -5, 0), midpoint: xy(0, 5) }],
    ['arc across the 0/2π wrap', docWith(arc((7 * Math.PI) / 4, (9 * Math.PI) / 4)), { midpoint: xy(5, 0) }],
    [
      'polyline',
      docWith({ id: 'p1', kind: 'polyline', points: xy(0, 0, 4, 0, 4, 3), closed: false }),
      { endpoint: xy(0, 0, 4, 0, 4, 3), midpoint: xy(2, 0, 4, 1.5) },
    ],
  ])('%s', (_, doc, expected) => {
    for (const [type, pts] of Object.entries(expected)) {
      const found = of(doc, type);
      expect(found, type).toHaveLength(pts.length);
      for (const [x, y] of pts) expect(found).toContainEqual(near(x, y));
    }
  });

  it('rectangle edge midpoints; mixed docs; empty docs; CollectOpts toggles', () => {
    const rect = of(docWith({ id: 'r1', kind: 'rectangle', width: 10, height: 4 }), 'midpoint');
    expect(rect).toHaveLength(4);
    expect(rect).toContainEqual(near(5, 0));
    expect(rect).toContainEqual(near(5, 4));
    const types = new Set(collectSnapCandidates(docWith(line([0, 0], [10, 0]), circle([5, 5], 3))).map((c) => c.type));
    expect([types.has('endpoint'), types.has('center')]).toEqual([true, true]);
    expect(collectSnapCandidates(createEmptyDocument())).toHaveLength(0);
    expect([of(LINE, 'endpoint', { endpoints: false }).length, of(LINE, 'midpoint', { endpoints: false }).length]).toEqual([0, 1]);
    expect([of(LINE, 'midpoint', { midpoints: false }).length, of(LINE, 'endpoint', { midpoints: false }).length]).toEqual([0, 2]);
  });

  it.each<[string, CadDocument, object, unknown[], number[] | null]>([
    ['perpendicular', LINE, {}, [[5, 3]], [5, 0]],
    ['perpendicular', LINE, {}, [[-5, 3]], null],
    ['perpendicular', LINE, { perpendiculars: false }, [[5, 3]], null],
    ['tangent', docWith(circle([0, 0], 1)), {}, [[2, 0]], [2]],
    ['tangent', docWith(circle([0, 0], 5)), {}, [[2, 0]], null],
    ['tangent', docWith(circle([0, 0], 1)), { tangents: false }, [[2, 0]], null],
    ['extension', LINE, { extensions: true }, [null, [12, 0]], [12, 0]],
    ['extension', LINE, {}, [null, [12, 0]], null],
    ['extension', LINE, { extensions: false }, [null, [12, 0]], null],
    ['nearest', LINE, { nearest: true }, [null, [5, 3]], [5, 0]],
    ['nearest', LINE, {}, [null, [5, 3]], null],
    ['nearest', LINE, { nearest: false }, [null, [5, 3]], null],
  ])('advanced %s snap with opts %j, points %j', (type, doc, opts, points, expected) => {
    const found = of(doc, type, opts, ...points);
    if (!expected) return expect(found).toHaveLength(0);
    if (expected.length === 1) return expect(found).toHaveLength(expected[0]!);
    expect(found).toContainEqual(near(expected[0]!, expected[1]!));
  });
});

describe('snap', () => {
  const at = (cursor: [number, number], candidates: Array<[number, number, SnapType]>, grid = 1): ReturnType<typeof snap> =>
    snap(
      cursor,
      candidates.map(([x, y, type]) => ({ x, y, type })),
      grid,
      0.5,
    );

  it('snaps to the nearest candidate in tolerance, else the grid, else nothing', () => {
    expect(at([5.1, 0.1], [[5, 0, 'endpoint']])).toMatchObject({ snapped: true, type: 'endpoint', x: 5, y: 0 });
    expect(at([5.6, 0.6], [[5, 0, 'endpoint']])).toMatchObject({ type: 'grid', x: 6, y: 1 });
    expect(at([3.7, 2.3], [])).toMatchObject({ snapped: true, type: 'grid', x: 4, y: 2 });
    expect(at([3.2, 3.2], [[3, 3, 'center']])).toMatchObject({ type: 'center', x: 3, y: 3 });
    expect(
      at(
        [0.2, 0],
        [
          [0, 0, 'endpoint'],
          [10, 0, 'endpoint'],
        ],
      ),
    ).toMatchObject({ x: 0, y: 0 });
    const none = at([1.7, 2.3], [], 0);
    expect([none.snapped, none.type]).toEqual([false, null]);
    close2([none.x, none.y], 1.7, 2.3);
  });

  it.each<[SnapType, SnapType]>([
    ['endpoint', 'midpoint'],
    ['midpoint', 'center'],
    ['center', 'intersection'],
    ['endpoint', 'perpendicular'],
    ['intersection', 'perpendicular'],
    ['perpendicular', 'tangent'],
    ['tangent', 'extension'],
    ['extension', 'nearest'],
  ])('prefers %s over %s at equal distance', (winner, loser) =>
    expect(
      at(
        [1, 0],
        [
          [1, 0, loser],
          [1, 0, winner],
        ],
      ).type,
    ).toBe(winner),
  );
});

describe('applyOrthoPolar', () => {
  const polar15 = (15 * Math.PI) / 180;

  it.each<[[number, number], [number, number], object, [number, number]]>([
    [[0, 0], [3, 4], { ortho: false, polar: false }, [3, 4]],
    [[0, 0], [5, 1], { ortho: true, polar: false }, [5, 0]],
    [[0, 0], [1, 5], { ortho: true, polar: false }, [0, 5]],
    [[3, 3], [8, 4], { ortho: true, polar: false }, [8, 3]],
    [[0, 0], [5, 1], { ortho: true, polar: true }, [5, 0]],
    [[3, 4], [3, 4], { ortho: true, polar: false }, [3, 4]],
    [[0, 0], [5, 0.1], { ortho: false, polar: true, polarIncrement: polar15 }, [Math.hypot(5, 0.1), 0]],
  ])('%j → %j with %j', (origin, cursor, opts, expected) =>
    close2(applyOrthoPolar(origin, cursor, opts as Parameters<typeof applyOrthoPolar>[2]), ...expected),
  );

  it.each([polar15, 0])('snaps 22.5° to 30° with polarIncrement %d (0 = the 15° default, never NaN)', (polarIncrement) => {
    const a = (22.5 * Math.PI) / 180;
    const r = applyOrthoPolar([0, 0], [5 * Math.cos(a), 5 * Math.sin(a)], { ortho: false, polar: true, polarIncrement });
    expect(r.some(Number.isNaN)).toBe(false);
    close2(r, 5 * Math.cos(Math.PI / 6), 5 * Math.sin(Math.PI / 6));
  });
});

describe('snap geometry helpers', () => {
  it('snapPerpendicular returns the foot inside the segment only', () => {
    expect(snapPerpendicular([5, 3], 0, 0, 10, 0)).toMatchObject({ type: 'perpendicular', x: expect.closeTo(5), y: expect.closeTo(0) });
    for (const [from, seg] of [
      [
        [-2, 3],
        [0, 0, 10, 0],
      ],
      [
        [12, 3],
        [0, 0, 10, 0],
      ],
      [null, [0, 0, 10, 0]],
      [
        [5, 5],
        [3, 3, 3, 3],
      ],
    ] as const)
      expect(snapPerpendicular(from as [number, number] | null, ...(seg as [number, number, number, number]))).toBeNull();
  });

  it('tangentPointsToCircle: two points outside / on the edge, none inside or at the centre', () => {
    const pts = tangentPointsToCircle(2, 0, 0, 0, 1);
    expect(pts).toHaveLength(2);
    for (const [tx, ty] of pts) {
      expect(tx).toBeCloseTo(0.5);
      expect(Math.abs(ty)).toBeCloseTo(Math.sqrt(3) / 2);
      expect(tx * (2 - tx) + ty * -ty).toBeCloseTo(0);
    }
    expect(tangentPointsToCircle(2, 0, 0, 0, 5)).toHaveLength(0);
    const edge = tangentPointsToCircle(1, 0, 0, 0, 1);
    expect(edge).toHaveLength(2);
    close2(edge[0], 1, 0);
    expect(tangentPointsToCircle(0, 0, 0, 0, 3)).toHaveLength(0);
    expect(snapTangentToCircle([2, 0], 0, 0, 1).map((s) => s.type)).toEqual(['tangent', 'tangent']);
    expect(snapTangentToCircle(null, 0, 0, 1)).toHaveLength(0);
    expect(snapTangentToCircle([1, 0], 0, 0, 5)).toHaveLength(0);
  });

  it.each<[number[], [number, number] | null]>([
    [
      [12, 0, 0, 0, 10, 0],
      [12, 0],
    ],
    [
      [-3, 0, 0, 0, 10, 0],
      [-3, 0],
    ],
    [[5, 2, 0, 0, 10, 0], null],
    [[5, 5, 3, 3, 3, 3], null],
    [
      [6, 6, 0, 0, 4, 4],
      [6, 6],
    ],
  ])('snapExtension(%j)', (args, expected) => {
    const r = snapExtension(...(args as [number, number, number, number, number, number]));
    if (!expected) return expect(r).toBeNull();
    expect(r!.type).toBe('extension');
    close2([r!.x, r!.y], ...expected);
  });

  it.each<[number[], [number, number]]>([
    [
      [5, 3, 0, 0, 10, 0],
      [5, 0],
    ],
    [
      [-3, 2, 0, 0, 10, 0],
      [0, 0],
    ],
    [
      [15, 2, 0, 0, 10, 0],
      [10, 0],
    ],
    [
      [5, 5, 3, 3, 3, 3],
      [3, 3],
    ],
  ])('nearestOnSegment(%j)', (args, expected) =>
    close2(nearestOnSegment(...(args as [number, number, number, number, number, number])), ...expected),
  );

  it.each<[number[], boolean, [number, number]]>([
    [[3, 4, 0, 0, 5, 0, 0], true, [3, 4]],
    [[3, 4, 0, 0, 5, 0, Math.PI], false, [3, 4]],
    [[0, -5, 0, 0, 5, Math.PI / 4, (3 * Math.PI) / 4], false, [5 * Math.cos((3 * Math.PI) / 4), 5 * Math.sin((3 * Math.PI) / 4)]],
  ])('nearestOnArc(%j, full=%s)', (args, full, expected) =>
    close2(nearestOnArc(...(args as [number, number, number, number, number, number, number]), full), ...expected),
  );
});

const arcDoc = (startAngle: number, endAngle: number): CadDocument =>
  ({
    ...createEmptyDocument(),
    entities: {
      a1: {
        id: 'a1',
        kind: 'arc',
        center: [0, 0],
        radius: 1,
        startAngle,
        endAngle,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        layerId: 'layer-default',
        color: '#ffffff',
      },
    },
    order: ['a1'],
  }) as CadDocument;

describe('isAngleOnArc', () => {
  it('respects the CCW sweep including the 0/2π wrap', () => {
    expect(isAngleOnArc(0.1, 0, Math.PI)).toBe(true);
    expect(isAngleOnArc(-0.1, 0, Math.PI)).toBe(false);
    expect(isAngleOnArc(0, 1.5 * Math.PI, 0.5 * Math.PI)).toBe(true);
    expect(isAngleOnArc(Math.PI, 1.5 * Math.PI, 0.5 * Math.PI)).toBe(false);
  });
});

describe('arc tangent snaps', () => {
  it('only offers tangent points that lie on the swept arc', () => {
    // Upper half arc; from (2,0) tangent points are at ±60°; only +60° is on the arc.
    const tangents = collectSnapCandidates(arcDoc(0, Math.PI), {}, [2, 0]).filter((p) => p.type === 'tangent');
    expect(tangents).toHaveLength(1);
    expect(tangents[0]?.x).toBeCloseTo(0.5);
    expect(tangents[0]?.y).toBeCloseTo(Math.sqrt(3) / 2);
  });
});

const unit: CircularCurve = { cx: 0, cy: 0, r: 1, startAngle: 0, endAngle: 0, full: true };

describe('segmentCurveIntersections', () => {
  it('finds two crossings, one tangent touch, and none', () => {
    expect(segmentCurveIntersections([-2, 0, 2, 0], unit)).toHaveLength(2);
    expect(segmentCurveIntersections([-2, 1, 2, 1], unit)).toHaveLength(1);
    expect(segmentCurveIntersections([-2, 2, 2, 2], unit)).toHaveLength(0);
  });
  it('ignores crossings outside the finite segment or the arc sweep', () => {
    expect(segmentCurveIntersections([0, 0, 0.5, 0], unit)).toHaveLength(0);
    const upper: CircularCurve = { ...unit, endAngle: Math.PI, full: false };
    const pts = segmentCurveIntersections([-2, 0, 2, 0], upper);
    expect(pts).toHaveLength(2); // both endpoints of the half arc lie on the x axis
    expect(segmentCurveIntersections([0, -2, 0, -0.5], upper)).toHaveLength(0);
  });
  it('returns [] for a degenerate segment', () => {
    expect(segmentCurveIntersections([1, 0, 1, 0], unit)).toEqual([]);
  });
});

describe('curveCurveIntersections', () => {
  it('finds two points for overlapping circles and none for disjoint/concentric', () => {
    const other: CircularCurve = { ...unit, cx: 1 };
    const pts = curveCurveIntersections(unit, other);
    expect(pts).toHaveLength(2);
    expect(pts[0]?.[0]).toBeCloseTo(0.5);
    expect(curveCurveIntersections(unit, { ...unit, cx: 5 })).toEqual([]);
    expect(curveCurveIntersections(unit, { ...unit, r: 2 })).toEqual([]);
  });
});

describe('collectSnapCandidates — curve intersections', () => {
  it('snaps line × circle crossings', () => {
    const base = {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      layerId: 'layer-default',
      color: '#ffffff',
    };
    const document = {
      ...createEmptyDocument(),
      entities: {
        l1: { ...base, id: 'l1', kind: 'line', start: [-3, 0], end: [3, 0] },
        c1: { ...base, id: 'c1', kind: 'circle', center: [0, 0], radius: 2 },
      },
      order: ['l1', 'c1'],
    } as CadDocument;
    const hits = collectSnapCandidates(document).filter((p) => p.type === 'intersection');
    expect(hits).toHaveLength(2);
    expect(hits.map((p) => p.x).sort()).toEqual([-2, 2]);
  });
});

const base = {
  position: [10, 0, 0] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  layerId: 'layer-default',
  color: '#ffffff',
};

describe('collectSnapCandidates — ellipse and spline', () => {
  it('snaps an ellipse center and quadrant points (position applied)', () => {
    const document = {
      ...createEmptyDocument(),
      entities: { e1: { ...base, id: 'e1', kind: 'ellipse', center: [1, 2], radiusX: 4, radiusY: 2 } },
      order: ['e1'],
    } as CadDocument;
    const pts = collectSnapCandidates(document);
    expect(pts).toContainEqual({ x: 11, y: 2, type: 'center' });
    expect(pts).toContainEqual({ x: 15, y: 2, type: 'endpoint' });
    expect(pts).toContainEqual({ x: 11, y: 0, type: 'endpoint' });
  });
  it('snaps every spline through-point as an endpoint', () => {
    const document = {
      ...createEmptyDocument(),
      entities: { s1: { ...base, id: 's1', kind: 'spline', points: xy(0, 0, 1, 1, 2, 0), closed: false } },
      order: ['s1'],
    } as CadDocument;
    const pts = collectSnapCandidates(document);
    expect(pts.filter((p) => p.type === 'endpoint')).toHaveLength(3);
    expect(pts).toContainEqual({ x: 11, y: 1, type: 'endpoint' });
  });
});

const QUARTER_TURN = Math.PI / 2;
const rotatedBase = {
  position: [10, 0, 0] as [number, number, number],
  rotation: [0, 0, QUARTER_TURN] as [number, number, number],
  layerId: 'layer-default',
  color: '#ffffff',
};

const docOf = (entity: Record<string, unknown>): CadDocument =>
  ({ ...createEmptyDocument(), entities: { e: { ...rotatedBase, id: 'e', ...entity } }, order: ['e'] }) as unknown as CadDocument;

describe('2D snapping honours rotation about Z', () => {
  it('localToWorld2D rotates about the entity origin then offsets', () => {
    const entity = { ...rotatedBase, id: 'e', kind: 'point' } as Entity;
    const [x, y] = localToWorld2D(entity, 2, 0);
    expect(x).toBeCloseTo(10);
    expect(y).toBeCloseTo(2);
  });
  it('rotates line endpoints and midpoint', () => {
    const pts = collectSnapCandidates(docOf({ kind: 'line', start: [0, 0], end: [4, 0] }));
    const end = pts.find((p) => p.type === 'endpoint' && p.y > 3);
    expect(end?.x).toBeCloseTo(10);
    expect(end?.y).toBeCloseTo(4);
    const midpoint = pts.find((p) => p.type === 'midpoint');
    expect(midpoint?.y).toBeCloseTo(2);
  });
  it('rotates rectangle corners and center', () => {
    const doc = docOf({ kind: 'rectangle', width: 4, height: 2 });
    const pts = collectSnapCandidates(doc);
    const center = pts.find((p) => p.type === 'center');
    expect(center?.x).toBeCloseTo(9); // local (2,1) -> (-1,2) + (10,0)
    expect(center?.y).toBeCloseTo(2);
    const [first] = entityToSegments(doc.entities['e'] as Entity);
    expect(first?.[2]).toBeCloseTo(10);
    expect(first?.[3]).toBeCloseTo(4);
  });
  it('shifts arc end angles by the rotation', () => {
    const pts = collectSnapCandidates(docOf({ kind: 'arc', center: [0, 0], radius: 2, startAngle: 0, endAngle: QUARTER_TURN }));
    const endpoints = pts.filter((p) => p.type === 'endpoint');
    expect(endpoints[0]?.x).toBeCloseTo(10);
    expect(endpoints[0]?.y).toBeCloseTo(2);
    expect(endpoints[1]?.x).toBeCloseTo(8);
    expect(endpoints[1]?.y).toBeCloseTo(0);
  });
});
