/** Pure helpers behind the audit fixes: period detection, time-series chart, jam detection. */
import { describe, expect, it } from 'vitest';
import { findPeriod, tailMean } from '@core/dynamics/periodicity';
import { timeSeriesSvg } from '@lib/timeSeriesSvg';
import { warnJams } from '@core/dynamics/jamDetection';
import type { DynamicsModel } from '@core/model/dynamics';
import type { SimulationTrace } from '@core/dynamics/physicsEngine';

const times = (n: number, dt: number): number[] => Array.from({ length: n }, (_, i) => i * dt);

describe('findPeriod', () => {
  it('finds the period of a sine to within 2 %, with a non-integer number of samples per cycle', () => {
    const t = times(400, 0.02);
    const period = findPeriod(
      t.map((x) => 3 * Math.sin((2 * Math.PI * x) / 1.27) + 1),
      t,
    );
    expect(period?.periodS ?? 0).toBeCloseTo(1.27, 1);
    expect(Math.abs((period?.periodS ?? 0) - 1.27) / 1.27).toBeLessThan(0.02);
  });

  it('ignores an early transient before a periodic tail', () => {
    const t = times(600, 0.01);
    const values = t.map((x) => (x < 1 ? 10 * (1 - x) : 0) + Math.sin((2 * Math.PI * x) / 0.5));
    expect(findPeriod(values, t)?.periodS ?? 0).toBeCloseTo(0.5, 1);
  });

  it('is null for a ramp, a constant, a decaying signal, too few samples and bad times', () => {
    const t = times(300, 0.02);
    expect(findPeriod(t, t)).toBeNull();
    expect(
      findPeriod(
        t.map(() => 5),
        t,
      ),
    ).toBeNull();
    expect(
      findPeriod(
        t.map((x) => Math.exp(-x) * Math.sin(10 * x)),
        t,
      ),
    ).toBeNull();
    expect(findPeriod([1, 2, 1, 2], [0, 1, 2, 3])).toBeNull();
    expect(
      findPeriod(
        t.map(Math.sin),
        t.map(() => 0),
      ),
    ).toBeNull();
  });

  it('tailMean averages the last window and tolerates empty input', () => {
    expect(tailMean([1, 2, 3, 4], 2)).toBe(3.5);
    expect(tailMean([], 3)).toBe(0);
    expect(tailMean([2, 4], 10)).toBe(3);
  });
});

describe('timeSeriesSvg', () => {
  const layout = { title: 'T & <U>', width: 600, panelHeight: 200, times: times(4000, 0.001) };

  it('draws every panel with thinned polylines, escaped text, a flat series and non-finite samples', () => {
    const { svg, height } = timeSeriesSvg(
      [
        { title: 'Big', unit: 'N', series: [{ label: 'a<b', values: layout.times.map((t) => 2e7 * Math.sin(t * 20)) }] },
        { title: 'Flat', unit: 'm', series: [{ label: 'flat', values: layout.times.map(() => 0) }] },
        { title: 'Tiny', unit: 'm', series: [{ label: 'nan', values: layout.times.map((t, i) => (i % 2 === 0 ? 3e-5 * t : Number.NaN)) }] },
      ],
      layout,
    );
    expect(height).toBe(40 + 3 * 200);
    expect(svg).toContain('T &amp; &lt;U&gt;');
    expect(svg).toContain('a&lt;b');
    expect(svg).toMatch(/e\+7|e\+6/);
    expect((svg.match(/<polyline/g) ?? []).length).toBe(3);
    const points = (/points="([^"]+)"/.exec(svg)?.[1] ?? '').split(' ').length;
    expect(points).toBeLessThanOrEqual(1502);
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('survives a one-sample run', () => {
    const { svg } = timeSeriesSvg([{ title: 'P', unit: 'u', series: [{ label: 's', values: [1] }] }], { ...layout, times: [0] });
    expect(svg).toContain('<svg');
  });
});

describe('warnJams', () => {
  const dynamics = { motors: { m: { id: 'm', kind: 'speed', joint: 'j', rpm: 60, maxTorque: 10 } } } as unknown as DynamicsModel;
  const trace = (speed: number): SimulationTrace =>
    ({ jointVelocity: { j: Array.from({ length: 40 }, () => speed) } }) as unknown as SimulationTrace;
  const torque = (value: number): Record<string, number[]> => ({ m: Array.from({ length: 40 }, () => value) });

  it('warns for a saturated motor that does not turn, not for one at speed, unsaturated, or on a torque-curve motor', () => {
    const jam: string[] = [];
    warnJams(dynamics, trace(0.1), torque(10), jam);
    expect(jam[0]).toMatch(/motor 'm' sits at its 10 N·m limit.*toggle \/ lock-up detected/);
    for (const [speed, load] of [
      [2 * Math.PI, 10],
      [0.1, 3],
    ] as const) {
      const quiet: string[] = [];
      warnJams(dynamics, trace(speed), torque(load), quiet);
      expect(quiet).toEqual([]);
    }
    const curve = { motors: { m: { id: 'm', kind: 'torque_curve', joint: 'j', curve: [], throttle: 1 } } } as unknown as DynamicsModel;
    const none: string[] = [];
    warnJams(curve, trace(0), torque(10), none);
    expect(none).toEqual([]);
  });
});
