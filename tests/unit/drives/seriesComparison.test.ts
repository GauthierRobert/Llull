/** compareSeries (PHY-23 DRV-M3): the arithmetic against hand values, the refusals, and linear time in the number of reference points. */
import { describe, expect, it } from 'vitest';
import type { ReferenceSeries } from '@core/model/drives';
import type { RunData } from '@dynamics/sim/runData';
import { compareSeries, type SeriesComparison } from '@dynamics/sim/seriesComparison';

/** A run with a joint 'j' whose speed is 2 t (rad/s) on `samples` samples over 6 s. */
const run = (samples: number): RunData =>
  ({
    duration: 6,
    series: {
      times: Array.from({ length: samples }, (_, k) => (6 * k) / (samples - 1)),
      jointVelocity: { j: Array.from({ length: samples }, (_, k) => (12 * k) / (samples - 1)) },
      jointPosition: { j: [] },
    },
  }) as unknown as RunData;

const reference = (times: number[], values: number[], extra: Partial<ReferenceSeries> = {}): ReferenceSeries => ({
  id: 'r',
  quantity: 'joint_velocity',
  target: 'j',
  times,
  values,
  source: { name: 'test', grade: 'A' },
  ...extra,
});
const ok = (result: ReturnType<typeof compareSeries>): SeriesComparison => {
  if ('refusal' in result) throw new Error(result.refusal);
  return result;
};

describe('compareSeries', () => {
  it('hand values: a reference 2 rad/s above the model at every point has RMS = peak = 2, scale = its largest value, relative 2 / 14 (fail, grade A)', () => {
    // the model speed at t = 1, 3, 6 is 2, 6, 12; the reference is 4, 8, 14
    const result = ok(compareSeries(reference([1, 3, 6], [4, 8, 14]), run(601)));
    expect(result.rmsError).toBeCloseTo(2, 9);
    expect(result.peakError).toBeCloseTo(2, 9);
    expect(result.scale).toBe(14);
    expect(result.relativeRms).toBeCloseTo(2 / 14, 9);
    expect(result.status).toBe('fail');
    expect(result.uncertainty).toBeNull();
    expect(result.peakErrorOverUncertainty).toBeNull();
  });

  it('the band and the grade decide the status; a stated uncertainty gives the error in reading sigmas', () => {
    const [times, values] = [
      [1, 3, 6],
      [4, 8, 14],
    ];
    expect(ok(compareSeries(reference(times, values, { bandRel: 0.2 }), run(601))).status).toBe('pass');
    expect(ok(compareSeries(reference(times, values, { source: { name: 'x', grade: 'C' } }), run(601))).status).toBe('warn');
    expect(ok(compareSeries(reference(times, values, { uncertainty: 0.5 }), run(601))).peakErrorOverUncertainty).toBeCloseTo(4, 9);
  });

  it('an all-zero reference is scaled by the largest simulated value', () => {
    const result = ok(compareSeries(reference([0, 6], [0, 0]), run(601)));
    expect(result.scale).toBe(12);
  });

  it('refuses with the reason: a reference longer than the run, a joint that is not there, a run with one sample', () => {
    expect(compareSeries(reference([0, 7], [0, 1]), run(601))).toEqual({
      refusal: 'the reference runs to 7 s, the run only to 6 s: simulate longer',
    });
    expect(compareSeries(reference([0, 1], [0, 1], { target: 'ghost' }), run(601))).toEqual({ refusal: "the run has no joint 'ghost'" });
    expect(
      compareSeries(reference([0], [0]), {
        ...run(2),
        series: { ...(run(2).series as object), times: [0], jointVelocity: { j: [0] } },
      } as unknown as RunData),
    ).toEqual({ refusal: 'the run recorded fewer than two samples: simulate longer or sample faster' });
  });

  it('time grows linearly with the number of reference points (100 x the points costs far less than 100 x quadratic time)', () => {
    const [small, large] = [100, 100_000].map((count) => {
      const times = Array.from({ length: count }, (_, k) => (6 * k) / (count - 1));
      const started = performance.now();
      ok(
        compareSeries(
          reference(
            times,
            times.map((t) => 2 * t),
          ),
          run(6001),
        ),
      );
      return performance.now() - started;
    }) as [number, number];
    // linear in (points + samples): about 17x for 1000x the reference points; a rescan per point would be 1000x
    expect(large / Math.max(small, 0.05)).toBeLessThan(400);
  });
});
