import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { CurveSegment } from '@core/model/curve';
import type { Vec2, Vec3 } from '@core/model/types';
import {
  arcGeometry,
  catmullRomBeziers,
  chainIssue,
  chainLength,
  filletPolyline,
  firstCorner,
  reverseChain,
  sampleChain,
  sampleProfile,
  segmentPoint,
  segmentSteps,
  segmentTangent,
} from '@core/geometry/curveSegments';
import { xy, xyz } from '../helpers/xy';

const close = (a: readonly number[], b: readonly number[], digits = 9): void =>
  a.forEach((v, k) => expect(v).toBeCloseTo(b[k] ?? 0, digits));

const quarterArc: CurveSegment<Vec2> = {
  type: 'arc',
  points: [
    [1, 0],
    [Math.SQRT1_2, Math.SQRT1_2],
    [0, 1],
  ],
};

describe('arcGeometry', () => {
  it('recovers centre, radius and the counter-clockwise sweep through the middle point', () => {
    const g = arcGeometry(...quarterArc.points);
    expect(g).not.toBeNull();
    close(g?.center ?? [], [0, 0, 0]);
    expect(g?.radius).toBeCloseTo(1, 12);
    expect(g?.sweep).toBeCloseTo(Math.PI / 2, 12);
  });
  it('takes the long way round when the through point is on the far side', () => {
    const g = arcGeometry([1, 0], [-1, 0], [0, 1]);
    expect(g?.sweep).toBeCloseTo((3 * Math.PI) / 2, 12);
  });
  it('works in 3D planes and rejects collinear points', () => {
    const g = arcGeometry([0, 0, 1], [0, 1, 0], [0, 0, -1]);
    expect(g?.radius).toBeCloseTo(1, 12);
    expect(arcGeometry([0, 0], [1, 1], [2, 2])).toBeNull();
  });
});

describe('segment evaluation', () => {
  it('points and tangents of lines, arcs and Béziers', () => {
    close(segmentPoint(quarterArc, 0.5), [Math.SQRT1_2, Math.SQRT1_2, 0]);
    close(segmentTangent(quarterArc, 0), [0, 1, 0]);
    close(segmentTangent(quarterArc, 1), [-1, 0, 0]);
    const line: CurveSegment<Vec3> = {
      type: 'line',
      points: [
        [0, 0, 0],
        [0, 0, 4],
      ],
    };
    close(segmentPoint(line, 0.25), [0, 0, 1]);
    close(segmentTangent(line, 0.5), [0, 0, 1]);
    const bezier: CurveSegment<Vec2> = {
      type: 'bezier',
      points: [
        [0, 0],
        [1, 0],
        [2, 1],
        [2, 2],
      ],
    };
    close(segmentPoint(bezier, 1), [2, 2, 0]);
    close(segmentTangent(bezier, 0), [1, 0, 0]);
    close(segmentTangent(bezier, 1), [0, 1, 0]);
  });
  it('a Bézier with a collapsed handle still has a tangent', () => {
    const cusp: CurveSegment<Vec2> = {
      type: 'bezier',
      points: [
        [0, 0],
        [0, 0],
        [1, 1],
        [2, 1],
      ],
    };
    const t = segmentTangent(cusp, 0);
    expect(Math.hypot(...t)).toBeCloseTo(1, 9);
    expect(t[0]).toBeGreaterThan(0);
  });
  it('a degenerate arc falls back to its chord', () => {
    const flat: CurveSegment<Vec2> = {
      type: 'arc',
      points: [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
    };
    close(segmentPoint(flat, 0.5), [1, 0, 0]);
    close(segmentTangent(flat, 0.5), [1, 0, 0]);
    expect(segmentSteps(flat)).toBe(1);
  });
  it('samples arcs finely, lines once and closes profiles without repeating the start', () => {
    expect(segmentSteps(quarterArc)).toBe(8);
    const square: CurveSegment<Vec2>[] = [
      {
        type: 'line',
        points: [
          [0, 0],
          [1, 0],
        ],
      },
      {
        type: 'line',
        points: [
          [1, 0],
          [1, 1],
        ],
      },
      {
        type: 'line',
        points: [
          [1, 1],
          [0, 1],
        ],
      },
      {
        type: 'line',
        points: [
          [0, 1],
          [0, 0],
        ],
      },
    ];
    expect(sampleProfile(square)).toEqual(xy(0, 0, 1, 0, 1, 1, 0, 1));
    expect(sampleChain(square.slice(0, 2), false)).toHaveLength(3);
  });
  it('chain length is exact for lines and arcs', () => {
    const chain: CurveSegment<Vec2>[] = [
      quarterArc,
      {
        type: 'line',
        points: [
          [0, 1],
          [-3, 1],
        ],
      },
    ];
    expect(chainLength(chain)).toBeCloseTo(Math.PI / 2 + 3, 12);
    const straightBezier: CurveSegment<Vec2> = {
      type: 'bezier',
      points: [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
      ],
    };
    expect(chainLength([straightBezier])).toBeCloseTo(3, 9);
  });
});

describe('chain checks', () => {
  const open: CurveSegment<Vec2>[] = [
    {
      type: 'line',
      points: [
        [0, 0],
        [1, 0],
      ],
    },
    {
      type: 'line',
      points: [
        [1, 0],
        [1, 1],
      ],
    },
  ];
  it('accepts connected chains and reverses them faithfully', () => {
    expect(chainIssue(open, false)).toBeNull();
    const back = reverseChain(open);
    expect(back[0]?.points).toEqual(xy(1, 1, 1, 0));
    expect(chainIssue(back, false)).toBeNull();
  });
  it.each([
    [[], false, 'no segments'],
    [
      [
        {
          type: 'line',
          points: [
            [0, 0],
            [Number.NaN, 0],
          ],
        },
      ],
      false,
      'non-finite',
    ],
    [
      [
        {
          type: 'line',
          points: [
            [0, 0],
            [0, 0],
          ],
        },
      ],
      false,
      'zero length',
    ],
    [
      [
        {
          type: 'arc',
          points: [
            [0, 0],
            [1, 0],
            [2, 0],
          ],
        },
      ],
      false,
      'collinear',
    ],
    [
      [
        {
          type: 'line',
          points: [
            [0, 0],
            [1, 0],
          ],
        },
        {
          type: 'line',
          points: [
            [2, 0],
            [3, 0],
          ],
        },
      ],
      false,
      'does not start',
    ],
    [
      [
        {
          type: 'line',
          points: [
            [0, 0],
            [1, 0],
          ],
        },
      ],
      true,
      'not closed',
    ],
    [
      [
        {
          type: 'arc',
          points: [
            [1, 0],
            [0, 1],
            [-1, 0],
          ],
        },
        {
          type: 'arc',
          points: [
            [-1, 0],
            [0, -1],
            [1, 0],
          ],
        },
      ],
      false,
      'ends where it starts',
    ],
  ] as Array<[CurveSegment<Vec2>[], boolean, string]>)('reports %#: %s', (chain, closed, text) => {
    expect(chainIssue(chain, closed)).toContain(text);
  });
  it('finds the first non-tangent joint', () => {
    expect(firstCorner(open)).toBe(1);
    expect(firstCorner([open[0] as CurveSegment<Vec2>])).toBe(-1);
  });
});

describe('catmullRomBeziers', () => {
  it.each([false, true])('reproduces three.js centripetal Catmull-Rom (closed=%s)', (closed) => {
    const points: Vec3[] = [
      [0, 0, 0],
      [4, 1, 0],
      [5, 5, 2],
      [1, 7, 1],
    ];
    const reference = new THREE.CatmullRomCurve3(
      points.map((p) => new THREE.Vector3(...p)),
      closed,
      'centripetal',
    );
    const segments = catmullRomBeziers(points, closed);
    expect(segments).toHaveLength(closed ? 4 : 3);
    segments.forEach((segment, i) => {
      for (const t of [0, 0.3, 0.7]) {
        const expected = reference.getPoint((i + t) / segments.length);
        close(segmentPoint(segment, t), [expected.x, expected.y, expected.z], 6);
      }
    });
  });
  it('keeps 2D points 2D and survives repeated points', () => {
    const segments = catmullRomBeziers<Vec2>(xy(0, 0, 0, 0, 3, 1), false);
    expect(segments[1]?.points.every((p) => p.length === 2)).toBe(true);
  });
});

describe('filletPolyline', () => {
  it('rounds a right-angle corner with a tangent arc of the bend radius', () => {
    const chain = filletPolyline(xyz(0, 0, 0, 10, 0, 0, 10, 10, 0), 2);
    expect(Array.isArray(chain)).toBe(true);
    const segments = chain as CurveSegment<Vec3>[];
    expect(segments.map((s) => s.type)).toEqual(['line', 'arc', 'line']);
    expect(segments[1]?.points[0]).toEqual([8, 0, 0]);
    close(segments[1]?.points[2] ?? [], [10, 2, 0]);
    expect(arcGeometry(...(segments[1] as unknown as { points: [Vec3, Vec3, Vec3] }).points)?.radius).toBeCloseTo(2, 9);
    expect(firstCorner(segments)).toBe(-1);
    expect(chainIssue(segments, false)).toBeNull();
  });
  it('keeps collinear points straight and lets consecutive bends share a run', () => {
    const chain = filletPolyline(xyz(0, 0, 0, 5, 0, 0, 10, 0, 0, 10, 4, 0, 14, 4, 0), 2) as CurveSegment<Vec3>[];
    expect(chain.map((s) => s.type)).toEqual(['line', 'line', 'arc', 'arc', 'line']);
  });
  it.each([
    [xyz(0, 0, 0, 5, 0, 0, 0, 0, 0), 1, 'doubles back'],
    [xyz(0, 0, 0, 2, 0, 0, 2, 2, 0), 5, 'too large'],
    [xyz(0, 0, 0, 0, 0, 0, 1, 0, 0), 1, 'coincide'],
  ] as Array<[Vec3[], number, string]>)('rejects %#', (points, radius, text) => {
    expect(filletPolyline(points, radius)).toContain(text);
  });
});
