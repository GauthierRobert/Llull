import { describe, it, expect } from 'vitest';
import type { CurveSegment } from '@core/model/curve';
import type { Vec2, Vec3 } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { validateEntityValue } from '@core/commands/persistence/guards';
import {
  chainIssue,
  chainLength,
  firstCorner,
  mapSegment,
  minCurvatureRadius,
  reverseChain,
  sampleChain,
  sampleProfile,
  segmentPoint,
  segmentSteps,
  segmentTangent,
} from '@core/geometry/curveSegments';
import { ellipseAxes, ellipseCurvature } from '@core/geometry/ellipseSegment';
import { chainMoments } from '@core/geometry/chainMoments';
import { closedFormVolume } from '@core/geometry/closedFormVolume';
import { constantEdges } from '@core/geometry/sweepEval/sectionEdges';
import { segmentOfCurve } from '@core/geometry/planeSegments';

const line = (a: Vec2, b: Vec2): CurveSegment<Vec2> => ({ type: 'line', points: [a, b] });

/** Quarter ellipse (a, 0) -> (0, b) about the origin. */
const quarter = (a: number, b: number): CurveSegment<Vec2> => ({
  type: 'ellipse',
  points: [
    [a, 0],
    [0, 0],
    [0, b],
  ],
});

/** 2:1 ellipsoidal head profile of diameter D: axis, quarter ellipse (D/2 radial, D/4 deep), back to the axis. */
const headProfile = (diameter: number): CurveSegment<Vec2>[] => [
  line([0, 0], [diameter / 2, 0]),
  quarter(diameter / 2, diameter / 4),
  line([0, diameter / 4], [0, 0]),
];

describe('ellipse segment evaluation', () => {
  it('lies on the ellipse and is tangent to the neighbouring axes at its ends', () => {
    const e = quarter(2, 1);
    expect(segmentPoint(e, 0)).toEqual([2, 0, 0]);
    const end = segmentPoint(e, 1);
    expect(end[0]).toBeCloseTo(0, 12);
    expect(end[1]).toBeCloseTo(1, 12);
    const [mx, my] = segmentPoint(e, 0.5);
    expect((mx / 2) ** 2 + my ** 2).toBeCloseTo(1, 12);
    const start = segmentTangent(e, 0);
    expect(start[0]).toBeCloseTo(0, 12);
    expect(start[1]).toBeCloseTo(1, 12);
    const finish = segmentTangent(e, 1);
    expect(finish[0]).toBeCloseTo(-1, 12);
    expect(finish[1]).toBeCloseTo(0, 12);
  });

  it('samples 16 steps and keeps joints unrepeated in a chain', () => {
    expect(segmentSteps(quarter(2, 1))).toBe(16);
    expect(sampleChain(headProfile(4), true)).toHaveLength(18);
    expect(sampleProfile(headProfile(4))).toHaveLength(18);
  });

  it('has the elliptic arc length, the knuckle radius b^2 / a and the end curvature a / b^2', () => {
    expect(chainLength([quarter(2, 1)])).toBeCloseTo(2.4221124, 6);
    expect(chainLength([quarter(1, 1)])).toBeCloseTo(Math.PI / 2, 12);
    expect(minCurvatureRadius(quarter(2, 1))).toBeCloseTo(0.5, 9);
    expect(
      ellipseCurvature(
        [
          [2, 0],
          [0, 0],
          [0, 1],
        ],
        0,
      ),
    ).toBeCloseTo(2, 12);
    expect(minCurvatureRadius(quarter(1, 1))).toBeCloseTo(1, 9);
  });

  it('reverses exactly and maps through affine functions', () => {
    const [back] = reverseChain([quarter(2, 1)]);
    expect(back?.type).toBe('ellipse');
    const reversed = segmentPoint(back as CurveSegment<Vec2>, 0.25);
    const forward = segmentPoint(quarter(2, 1), 0.75);
    expect(reversed[0]).toBeCloseTo(forward[0], 12);
    expect(reversed[1]).toBeCloseTo(forward[1], 12);
    const lifted = mapSegment(quarter(2, 1), ([x, y]): Vec3 => [x, y, 5]);
    expect(lifted.type).toBe('ellipse');
    expect(segmentPoint(lifted, 0.5)[2]).toBe(5);
  });

  it('finds principal axes of a sheared conjugate pair', () => {
    const axes = ellipseAxes([
      [2, 0],
      [0, 0],
      [1, 1],
    ]);
    expect(axes.a * axes.b).toBeCloseTo(2, 12);
    expect(axes.a).toBeGreaterThanOrEqual(axes.b);
    expect(axes.normal[2]).toBeCloseTo(2, 12);
    const swapped = ellipseAxes([
      [1, 0],
      [0, 0],
      [0, 3],
    ]);
    expect([swapped.a, swapped.b]).toEqual([expect.closeTo(3, 12), expect.closeTo(1, 12)]);
  });

  it('is G1 with a perpendicular line at the knuckle', () => {
    expect(firstCorner([line([2, -1], [2, 0]), quarter(2, 1)])).toBe(-1);
  });
});

describe('ellipse segment validation', () => {
  it('refuses collinear start / centre / end', () => {
    const collinear: CurveSegment<Vec2> = {
      type: 'ellipse',
      points: [
        [2, 0],
        [0, 0],
        [-1, 0],
      ],
    };
    expect(chainIssue([collinear], false)).toBe('ellipse 0 has collinear start, centre and end');
  });

  it('refuses non-finite points', () => {
    const bad: CurveSegment<Vec2> = {
      type: 'ellipse',
      points: [
        [Number.NaN, 0],
        [0, 0],
        [0, 1],
      ],
    };
    expect(chainIssue([bad], false)).toContain('non-finite');
  });

  it('accepts the 2:1 head profile as a closed chain', () => {
    expect(chainIssue(headProfile(4), true)).toBeNull();
  });

  it('is validated in saved entities (3 points per ellipse segment)', () => {
    const revolved = execute(createEmptyDocument(), 'revolve_profile', {
      profile: [
        [0, 0],
        [2, 0],
        [0, 1],
      ],
    });
    const entity = revolved.document.entities[revolved.affected[0] as string];
    expect(validateEntityValue({ ...entity, curves: headProfile(4) })).toBeNull();
    expect(validateEntityValue({ ...entity, curves: [{ type: 'ellipse', points: [[1, 0]] }] })).toContain('ellipse');
  });
});

describe('ellipse segment in exact consumers', () => {
  it('Pappus volume of a revolved 2:1 head equals pi D^3 / 24 to 1e-12', () => {
    for (const diameter of [4, 2.5, 1000]) {
      const curves = headProfile(diameter);
      const made = execute(createEmptyDocument(), 'revolve_profile', {
        profile: [
          [0, 0],
          [diameter / 2, 0],
          [0, diameter / 4],
        ],
      });
      const base = made.document.entities[made.affected[0] as string];
      if (base?.kind !== 'revolution') throw new Error('expected a revolution');
      const volume = closedFormVolume({ ...base, profile: sampleProfile(curves), curves });
      const exact = (Math.PI * diameter ** 3) / 24;
      expect(volume?.analytic).toBe(true);
      expect(Math.abs((volume?.volume ?? 0) - exact) / exact).toBeLessThan(1e-12);
    }
  });

  it('chain moments: quarter ellipse area pi a b / 4 and first moment a^2 b / 3', () => {
    const { area, momentX } = chainMoments(headProfile(4));
    expect(area).toBeCloseTo((Math.PI * 2 * 1) / 4, 12);
    expect(momentX).toBeCloseTo((2 * 2 * 1) / 3, 12);
  });

  it('moments of lines, arcs and Béziers agree with closed forms', () => {
    const square = [line([1, 0], [2, 0]), line([2, 0], [2, 1]), line([2, 1], [1, 1]), line([1, 1], [1, 0])];
    const unit = chainMoments(square);
    expect(unit.area).toBeCloseTo(1, 12);
    expect(unit.momentX).toBeCloseTo(1.5, 12);
    const half: CurveSegment<Vec2>[] = [
      {
        type: 'arc',
        points: [
          [1, 0],
          [0, 1],
          [-1, 0],
        ],
      },
      line([-1, 0], [1, 0]),
    ];
    expect(chainMoments(half).area).toBeCloseTo(Math.PI / 2, 12);
    const flat: CurveSegment<Vec2>[] = [
      {
        type: 'bezier',
        points: [
          [0, 0],
          [1, 0],
          [2, 0],
          [3, 0],
        ],
      },
      line([3, 0], [0, 0]),
    ];
    expect(chainMoments(flat).area).toBeCloseTo(0, 12);
    const collinearArc: CurveSegment<Vec2>[] = [
      {
        type: 'arc',
        points: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
      },
    ];
    expect(chainMoments(collinearArc).area).toBeCloseTo(0, 12);
  });

  it('is ONE rational quadratic section edge and a rational plane segment', () => {
    const section = { shape: 'profile', profile: [], curves: headProfile(4) } as unknown as Parameters<typeof constantEdges>[0];
    const edges = constantEdges(section);
    expect(edges).toHaveLength(3);
    expect(edges?.[1]).toEqual({
      degree: 2,
      poles: [
        [2, 0],
        [2, 1],
        [0, 1],
      ],
      weights: [1, Math.SQRT1_2, 1],
    });
    const piece = segmentOfCurve(quarter(2, 1));
    expect(piece.kind === 'nurbs' ? piece.curve.degree : -1).toBe(2);
  });
});
