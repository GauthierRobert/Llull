/** Load-displacement curves of the curve probes, read from the `.dat` tables of every stored increment (PHY-05 FR-NLS-08). */

import type { CurveProbe, FeResultsArtifact, NonlinearSettings, AnalysisCase } from '@core/model/analysis';
import { safeName } from '../decks/context';
import { loadBaseValue, multiplierAt } from './history';

export interface CurveData {
  readonly probeId: string;
  readonly name: string;
  /** Cumulative total time of each point (analysis step k spans [k, k+1]); the first point is the unloaded origin (0, 0, 0). */
  readonly time: readonly number[];
  readonly load: readonly number[];
  readonly displacement: readonly number[];
}

type Table = NonNullable<FeResultsArtifact['dat']>['tables'][number];

/** Values by time of the `.dat` tables of `set` whose title starts with `kind`; the component picker reads the numeric row. */
function seriesOf(tables: readonly Table[], kind: string, set: string, pick: (row: readonly number[]) => number): Map<number, number> {
  const out = new Map<number, number>();
  const marker = ` FOR SET ${set.toUpperCase()} AND TIME`;
  for (const table of tables) {
    if (!table.title.toLowerCase().startsWith(kind) || !table.title.toUpperCase().includes(marker)) continue;
    const row = table.rows[0];
    if (row !== undefined) out.set(table.time, pick(row));
  }
  return out;
}

/** Last three numbers of a printed row (`fx fy fz`, or `node fx fy fz`). */
const vector = (row: readonly number[]): readonly [number, number, number] => [row.at(-3) ?? 0, row.at(-2) ?? 0, row.at(-1) ?? 0];

const COMPONENT = { x: 0, y: 1, z: 2, ux: 0, uy: 1, uz: 2 } as const;

function component(values: readonly [number, number, number], which: 'x' | 'y' | 'z' | 'ux' | 'uy' | 'uz' | 'magnitude'): number {
  return which === 'magnitude' ? Math.hypot(...values) : (values[COMPONENT[which]] ?? 0);
}

/** Load axis of a probe at the stored times: a reaction table, or the multiplied load value. */
function loadSeries(
  analysis: AnalysisCase,
  nonlinear: NonlinearSettings,
  probe: CurveProbe,
  tables: readonly Table[],
  times: readonly number[],
): Map<number, number> {
  if (probe.load.kind === 'reaction') {
    const which = probe.load.component;
    return seriesOf(tables, 'total force', safeName(`C_${probe.load.constraintId}`), (row) => component(vector(row), which));
  }
  const load = Object.hasOwn(analysis.loads, probe.load.loadId) ? analysis.loads[probe.load.loadId] : undefined;
  const series = new Map<number, number>();
  if (load !== undefined) for (const time of times) series.set(time, loadBaseValue(load) * multiplierAt(nonlinear, load.loadCase, time));
  return series;
}

/**
 * One curve per curve probe of the case, in probe order: a point for every stored increment that has both the displacement and the load value
 * (times are matched exactly, they come from the same increments), preceded by the origin. Analysis units.
 * @invariant pure; points are sorted by time; a probe whose tables are absent gets only the origin
 */
export function extractCurves(analysis: AnalysisCase, results: FeResultsArtifact): CurveData[] {
  const nonlinear = analysis.nonlinear;
  if (nonlinear === undefined) return [];
  const tables = results.dat?.tables ?? [];
  return nonlinear.probeOrder.flatMap((probeId) => {
    const probe = nonlinear.probes[probeId];
    if (probe === undefined) return [];
    const dof = probe.displacement.dof;
    const displacements = seriesOf(tables, 'displacements', safeName(`N_${probeId}`), (row) => component(vector(row), dof));
    const times = [...displacements.keys()].sort((a, b) => a - b);
    const loads = loadSeries(analysis, nonlinear, probe, tables, times);
    const kept = times.filter((time) => loads.has(time));
    return [
      {
        probeId,
        name: probe.name,
        time: [0, ...kept],
        load: [0, ...kept.map((time) => loads.get(time) ?? 0)],
        displacement: [0, ...kept.map((time) => displacements.get(time) ?? 0)],
      },
    ];
  });
}
