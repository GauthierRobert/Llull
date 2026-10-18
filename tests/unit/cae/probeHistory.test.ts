import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { evaluateProbes } from '@cae/results/probes';
import { historySeries } from '@cae/results/probeHistory';
import { trustedRecord } from '@cae/shared/trust';
import { caseOf } from '@cae/shared/access';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { machineContext, must, recorded, resultsFor, thermalFixture, twoTetMesh } from './thermal/fixtures';

interface HistoryData {
  series: {
    probeId: string;
    name: string;
    unit: string;
    points: { time: number; value: number }[];
    missing: number;
    start: { time: number; value: number } | null;
    end: { time: number; value: number } | null;
    min: { time: number; value: number } | null;
    max: { time: number; value: number } | null;
  }[];
  svg: string | null;
  height: number | null;
}

/** Transient case heated from 20 to 100 degC at node 1 over four increments, with a temperature probe at node 1 and one at node 5. */
function heating(): { doc: ReturnType<typeof recorded>; analysisId: string; hot: string; cold: string; temperatures: number[] } {
  const base = thermalFixture({ type: 'heat_transient' });
  let doc = must(base.doc, 'set_initial_temperature', { analysisId: base.analysisId, value: 20, unit: 'degC' }).document;
  const probe = (name: string, point: number[]): string => {
    const added = must(doc, 'add_result_probe', { analysisId: base.analysisId, name, point, quantity: 'temperature' });
    doc = added.document;
    return added.affected[0] ?? '';
  };
  const hot = probe('hot', [0, 0, 0]);
  const cold = probe('cold', [1, 0, 0.05]);
  const fixture = { ...base, doc };
  const mesh = twoTetMesh(fixture, { nodeSets: { [`P_${hot}`]: [1], [`P_${cold}`]: [5] } });
  const temperatures = [20, 45, 80, 100];
  const results = resultsFor(
    fixture,
    mesh,
    temperatures.map((t, i) => ({ time: (i + 1) * 10, temperature: { 1: t, 2: 20, 3: 20, 4: 20, 5: 20 } })),
  );
  return { doc: recorded(fixture, mesh, results), analysisId: base.analysisId, hot, cold, temperatures };
}

const historyOf = (result: CommandResult): HistoryData => result.data as HistoryData;

describe('probe_history', () => {
  it('returns every increment: monotone heating, first / last equal the per-increment evaluation, summary lists start / end / min / max', () => {
    const { doc, analysisId, hot, temperatures } = heating();
    const result = execute(doc, 'probe_history', { analysisId }, machineContext());
    expect(result.rejected).toBeUndefined();
    expect(result.affected).toEqual([]);
    const series = historyOf(result).series.find((entry) => entry.probeId === hot);
    expect(series?.points).toEqual(temperatures.map((value, i) => ({ time: (i + 1) * 10, value })));
    const values = series?.points.map((point) => point.value) ?? [];
    expect(values.every((value, i) => i === 0 || value > (values[i - 1] ?? Infinity))).toBe(true);
    expect(series).toMatchObject({ unit: 'degC', missing: 0, start: { time: 10, value: 20 }, end: { time: 40, value: 100 } });
    expect(series?.min).toEqual({ time: 10, value: 20 });
    expect(series?.max).toEqual({ time: 40, value: 100 });
    const trust = trustedRecord(doc, caseOf(doc, analysisId)!, machineContext().feaArtifacts);
    const readings = evaluateProbes(caseOf(doc, analysisId)!, trust.meshArtifact!, trust.resultsArtifact!, 1);
    const direct = readings.find((reading) => reading.probeId === hot)?.values ?? [];
    expect(series?.points[0]?.value).toBe(direct[0]?.value);
    expect(series?.points.at(-1)?.value).toBe(direct.at(-1)?.value);
    expect(direct).toHaveLength(temperatures.length);
    expect(result.summary).toContain('hot (temperature) 4 increment(s): start 20 @10 s, end 100 @40 s, min 20 @10 s, max 100 @40 s degC');
  });

  it('draws one panel per unit as SVG, and plot: false returns numbers only', () => {
    const { doc, analysisId } = heating();
    const drawn = historyOf(execute(doc, 'probe_history', { analysisId }, machineContext()));
    expect(drawn.svg?.startsWith('<svg')).toBe(true);
    expect(drawn.svg?.match(/<polyline/g)).toHaveLength(2);
    expect(drawn.svg).toContain('hot (temperature)');
    expect(drawn.height).toBeGreaterThan(0);
    const plain = historyOf(execute(doc, 'probe_history', { analysisId, plot: false }, machineContext()));
    expect(plain.svg).toBeNull();
    expect(plain.series).toHaveLength(2);
  });

  it('restricts to the requested probes and is pure', () => {
    const { doc, analysisId, cold } = heating();
    const result = execute(doc, 'probe_history', { analysisId, probeIds: [cold] }, machineContext());
    expect(historyOf(result).series.map((entry) => entry.probeId)).toEqual([cold]);
    expect(historyOf(result).series[0]?.points.every((point) => point.value === 20)).toBe(true);
    expectPure(doc, () => execute(doc, 'probe_history', { analysisId }, machineContext()));
  });

  it('refuses an unknown analysis, an unknown probe and an unsolved case without changing the document', () => {
    const { doc, analysisId } = heating();
    expectNoOp(execute(doc, 'probe_history', { analysisId: 'nope' }, machineContext()), doc);
    expectNoOp(execute(doc, 'probe_history', { analysisId, probeIds: ['pr-x'] }, machineContext()), doc);
    const unsolved = thermalFixture({ type: 'heat_transient' });
    const refused = execute(unsolved.doc, 'probe_history', { analysisId: unsolved.analysisId }, machineContext());
    expect(refused.error?.code).toBe('FEA_RESULTS_MISSING');
    expect(refused.document).toBe(unsolved.doc);
  });

  it('historySeries keeps increments with values, counts the gaps and draws no SVG for a single increment', () => {
    const series = historySeries(
      [
        {
          probeId: 'a',
          name: 'a',
          quantity: 'temperature',
          unit: 'degC',
          nodeId: 1,
          nodeDistance: 0,
          values: [
            { loadCase: null, step: 1, time: 1, value: 5 },
            { loadCase: null, step: 2, time: 2, value: null },
          ],
        },
      ],
      undefined,
    );
    expect(series[0]).toMatchObject({ points: [{ time: 1, value: 5 }], missing: 1, min: { value: 5 }, max: { value: 5 } });
  });
});
