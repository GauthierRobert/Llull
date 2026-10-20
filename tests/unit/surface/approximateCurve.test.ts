import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type NurbsCurveEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { evaluateCurve } from '@lib/nurbs/evaluate';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';

const empty = createEmptyDocument();
const wave = (count: number, noise = 0): Array<[number, number, number]> =>
  Array.from({ length: count }, (_, i) => {
    const x = (i / (count - 1)) * 6;
    return [x, Math.sin(x) + noise * (i % 2 === 0 ? 1 : -1), 0.1 * x];
  });

describe('approximate_curve', () => {
  it('fits 400 points of a sine within the tolerance with far fewer poles, interpolating the ends', () => {
    const points = wave(400);
    const result = execute(empty, 'approximate_curve', { points, tolerance: 1e-4 });
    expect(result.affected).toHaveLength(1);
    const curve = (result.document.entities[result.affected[0]!] as NurbsCurveEntity).curve;
    const data = result.data as { maxDeviation: number; poleCount: number; degree: number };
    expect(data.maxDeviation).toBeLessThanOrEqual(1e-4);
    expect(data.poleCount).toBeLessThan(60);
    expect(data.poleCount).toBe(curve.poles.length);
    expect(data.degree).toBe(3);
    expect(evaluateCurve(curve, 0)[0]).toBeCloseTo(0, 12);
    expect(evaluateCurve(curve, 1)[0]).toBeCloseTo(6, 12);
    expect(result.document.order).toEqual(result.affected);
    expect(result.summary).toContain('approximate_curve');
  });

  it('a looser tolerance needs fewer poles, a higher degree range may need fewer still', () => {
    const points = wave(300);
    const poles = (params: Record<string, unknown>): number =>
      (execute(empty, 'approximate_curve', { points, ...params }).data as { poleCount: number }).poleCount;
    expect(poles({ tolerance: 1e-2 })).toBeLessThan(poles({ tolerance: 1e-5 }));
    expect(poles({ tolerance: 1e-5, degreeMin: 3, degreeMax: 5 })).toBeLessThanOrEqual(poles({ tolerance: 1e-5 }));
  });

  it('smooths noise that is within the tolerance (fewer poles than points)', () => {
    const result = execute(empty, 'approximate_curve', { points: wave(200, 1e-3), tolerance: 5e-3 });
    expect((result.data as { poleCount: number }).poleCount).toBeLessThan(40);
  });

  it('refuses an unreachable tolerance, bad parameters and bad points without changing the document', () => {
    const points = wave(100, 0.05);
    expectNoOp(execute(empty, 'approximate_curve', { points, tolerance: 1e-9, maxPoles: 10 }), empty, 'SRF_TOLERANCE_UNREACHABLE');
    expectNoOp(execute(empty, 'approximate_curve', { points, tolerance: 0 }), empty, 'SRF_PARAM_INVALID');
    expectNoOp(execute(empty, 'approximate_curve', { points, tolerance: 0.1, degreeMin: 4, degreeMax: 3 }), empty, 'SRF_PARAM_INVALID');
    expectNoOp(execute(empty, 'approximate_curve', { points, tolerance: 0.1, degreeMin: 0 }), empty, 'SRF_PARAM_INVALID');
    expectNoOp(execute(empty, 'approximate_curve', { points, tolerance: 0.1, maxPoles: 2 }), empty, 'SRF_PARAM_INVALID');
    expectNoOp(execute(empty, 'approximate_curve', { points: points.slice(0, 3), tolerance: 0.1 }), empty, 'SRF_POINTS_INSUFFICIENT');
    expectNoOp(
      execute(empty, 'approximate_curve', {
        points: [
          [0, 0, 0],
          [0, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
        ],
        tolerance: 0.1,
      }),
      empty,
      'SRF_POINTS_COINCIDENT',
    );
  });

  it('is pure', () => {
    expectPure(empty, () => execute(empty, 'approximate_curve', { points: wave(50), tolerance: 1e-3 }));
  });
});
