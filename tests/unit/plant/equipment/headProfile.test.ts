import { describe, expect, it } from 'vitest';
import { chainIssue, sampleProfile, segmentPoint } from '@core/geometry/curveSegments';
import { closedFormVolume } from '@core/geometry/closedFormVolume';
import type { CurveSegment } from '@core/model/curve';
import type { RevolutionEntity } from '@core/model/types';
import type { Vec2 } from '@core/model/types';
import { resolveHead } from '@aec/plant/equipment/geometry/heads';
import type { HeadShape } from '@aec/plant/equipment/geometry/heads';
import { headSurfaceHeight } from '@aec/plant/equipment/geometry/vesselFrame';
import { headProfileCurves, ringSection } from '@aec/plant/equipment/geometry/vesselProfile';
import type { HeadSpec } from '@aec/plant/equipment/model';

const R = 750;
const shapeOf = (spec: HeadSpec): HeadShape => {
  const head = resolveHead(spec, R, 'head');
  if ('error' in head) throw new Error(head.error);
  return head.shape;
};

const SPECS: Array<[string, HeadSpec]> = [
  ['ellipsoidal 2:1', { type: 'ellipsoidal', ratio: 2 }],
  ['ellipsoidal 3:1', { type: 'ellipsoidal', ratio: 3 }],
  ['hemispherical', { type: 'hemispherical' }],
  ['torispherical ASME F&D', { type: 'torispherical', standard: 'asme_fd' }],
  ['torispherical radii', { type: 'torispherical', crownRadius: 1200, knuckleRadius: 100 }],
  ['conical 60 degrees', { type: 'conical', halfAngleDeg: 60 }],
  ['flat', { type: 'flat' }],
];

describe('headProfileCurves (the one place that builds head meridians)', () => {
  it.each(SPECS)('%s: a connected chain from the rim to the apex at every offset', (_name, spec) => {
    const shape = shapeOf(spec);
    for (const offset of [0, 10]) {
      const curves = headProfileCurves(shape, R, offset);
      expect(chainIssue(curves, false), `offset ${offset}`).toBeNull();
      const start = segmentPoint(curves[0]!, 0);
      const end = segmentPoint(curves[curves.length - 1]!, 1);
      expect(end[0]).toBeCloseTo(0, 9);
      expect(start[1]).toBeCloseTo(0, 9);
      expect(start[0]).toBeGreaterThanOrEqual(R);
      if (offset === 0) expect(start[0]).toBeCloseTo(R, 9);
    }
  });

  it('ellipsoidal inside profile: radial error below 1e-5 R (the Bézier stand-in for the exact ellipse segment, decision Q3)', () => {
    const shape = shapeOf({ type: 'ellipsoidal', ratio: 2 });
    let worst = 0;
    for (const segment of headProfileCurves(shape, R, 0)) {
      for (let step = 0; step <= 50; step++) {
        const [x, z] = segmentPoint(segment, step / 50) as unknown as Vec2;
        worst = Math.max(worst, Math.abs(Math.hypot(x / R, z / shape.depth) - 1));
      }
    }
    expect(worst).toBeLessThan(1e-5);
  });

  it('the offset curve of an ellipsoidal head stays t from the inside surface (normal distance)', () => {
    const shape = shapeOf({ type: 'ellipsoidal', ratio: 2 });
    const inside = headProfileCurves(shape, R, 0).flatMap((segment) =>
      Array.from({ length: 4000 }, (_unused, step) => segmentPoint(segment, step / 3999)),
    );
    for (const segment of headProfileCurves(shape, R, 10)) {
      for (let step = 0; step <= 10; step++) {
        const [x, z] = segmentPoint(segment, step / 10);
        const nearest = Math.min(...inside.map((p) => Math.hypot(p[0] - x, p[1] - z)));
        expect(Math.abs(nearest - 10)).toBeLessThan(0.05);
      }
    }
  });

  it.each(SPECS)('%s: headSurfaceHeight is the depth on the axis and 0 at the rim', (_name, spec) => {
    const shape = shapeOf(spec);
    expect(headSurfaceHeight(shape, R, 0)).toBeCloseTo(shape.depth, 9);
    expect(headSurfaceHeight(shape, R, R)).toBeCloseTo(0, 6);
  });

  it('ringSection is a closed rectangle', () => {
    const ring = ringSection(10, 20, 0, 5);
    expect(chainIssue(ring.curves, true)).toBeNull();
    expect(ring.profile).toEqual([
      [10, 0],
      [20, 0],
      [20, 5],
      [10, 5],
    ]);
  });
});

describe('ellipsoidal heads use the exact ellipse segment (decision Q3)', () => {
  const shape = shapeOf({ type: 'ellipsoidal', ratio: 2 });

  it('the inside profile is ONE exact quarter ellipse, the constant-thickness outer offset stays a Bézier chain', () => {
    const inside = headProfileCurves(shape, R, 0);
    expect(inside).toEqual([
      {
        type: 'ellipse',
        points: [
          [R, 0],
          [0, 0],
          [0, shape.depth],
        ],
      },
    ]);
    const outside = headProfileCurves(shape, R, 10);
    expect(outside.every((segment) => segment.type === 'bezier')).toBe(true);
  });

  it('the revolved inside head has the closed-form volume pi D^3 / 24 (core closed-form volume of the derived revolution)', () => {
    const chain = [
      {
        type: 'line',
        points: [
          [0, 0],
          [R, 0],
        ],
      },
      ...headProfileCurves(shape, R, 0),
      {
        type: 'line',
        points: [
          [0, shape.depth],
          [0, 0],
        ],
      },
    ] as CurveSegment<Vec2>[];
    expect(chainIssue(chain, true)).toBeNull();
    const entity = {
      kind: 'revolution',
      profile: sampleProfile(chain),
      curves: chain,
      axis: [0, 0, 1],
      angle: 2 * Math.PI,
      segments: 64,
    } as unknown as RevolutionEntity;
    const volume = closedFormVolume(entity)?.volume ?? 0;
    expect(Math.abs(volume / ((Math.PI * (2 * R) ** 3) / 24) - 1)).toBeLessThan(1e-9);
  });
});
