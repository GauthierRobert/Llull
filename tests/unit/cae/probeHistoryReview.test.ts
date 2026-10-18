import { describe, expect, it } from 'vitest';
import { timeSeriesSvg } from '@lib/timeSeriesSvg';
import type { ProbeReading } from '@cae/results/probes';
import { historySeries, type HistorySeries } from '@cae/results/probeHistory';
import { probeHistorySvg } from '@cae/results/probeHistorySvg';

const reading = (values: { time: number; value: number | null }[], extra: Partial<ProbeReading> = {}): ProbeReading =>
  ({ probeId: 'pr-1', name: 'hot', quantity: 'temperature', unit: 'degC', nodeId: 1, nodeDistance: 0, values, ...extra }) as ProbeReading;

const only = (entries: (HistorySeries | undefined)[]): HistorySeries[] => entries.flatMap((entry) => (entry ? [entry] : []));

describe('probe history with missing or non-finite increments (R2)', () => {
  it('keeps only finite points and still plots when at least two remain', () => {
    const [series] = historySeries([
      reading([
        { time: 10, value: 20 },
        { time: 20, value: null },
        { time: 30, value: Number.NaN },
        { time: 40, value: 100 },
        { time: 50, value: Number.POSITIVE_INFINITY },
      ]),
    ]);
    expect(series?.points).toEqual([
      { time: 10, value: 20 },
      { time: 40, value: 100 },
    ]);
    expect(series?.missing).toBe(3);
    const chart = probeHistorySvg(only([series]), 'title', 600, 200);
    expect(chart?.svg.match(/<polyline/g)).toHaveLength(1);
    expect(chart?.svg).not.toContain('NaN');
  });

  it('draws nothing for a series with fewer than two finite points', () => {
    const [series] = historySeries([
      reading([
        { time: 10, value: 20 },
        { time: 20, value: null },
      ]),
    ]);
    expect(probeHistorySvg(only([series]), 't', 600, 200)).toBeNull();
    const nan: HistorySeries = {
      ...(series as HistorySeries),
      points: [
        { time: 1, value: Number.NaN },
        { time: 2, value: 3 },
      ],
    };
    expect(probeHistorySvg([nan], 't', 600, 200)).toBeNull();
  });

  it('puts each probe on its own increments and one panel per unit', () => {
    const [a, b] = historySeries([
      reading([
        { time: 0, value: 1 },
        { time: 10, value: 2 },
        { time: 20, value: 3 },
      ]),
      reading(
        [
          { time: 5, value: 7 },
          { time: 25, value: 9 },
        ],
        { probeId: 'pr-2', name: 'cold', unit: 'MPa' },
      ),
    ]);
    const chart = probeHistorySvg(only([a, b]), 'two', 600, 200);
    expect(chart?.svg.match(/<polyline/g)).toHaveLength(2);
    expect(chart?.height).toBe(40 + 2 * 200);
    expect(chart?.svg).toContain('hot (temperature)');
    expect(chart?.svg).toContain('cold (temperature)');
  });
});

describe('shared timeSeriesSvg (R5)', () => {
  it('accepts per-series times, skips non-finite pairs and can leave zero out of the value axis', () => {
    const panels = [{ title: 'P', unit: 'u', series: [{ label: 's', times: [1, 2, Number.NaN, 4], values: [100, 110, 5, 120] }] }];
    const withZero = timeSeriesSvg(panels, { title: 't', width: 500, panelHeight: 200 }).svg;
    const withoutZero = timeSeriesSvg(panels, { title: 't', width: 500, panelHeight: 200, includeZero: false }).svg;
    expect(withZero.match(/points="([^"]*)"/)?.[1]?.split(' ')).toHaveLength(3);
    expect(withoutZero).not.toBe(withZero);
    expect(withZero).not.toContain('NaN');
  });
});
