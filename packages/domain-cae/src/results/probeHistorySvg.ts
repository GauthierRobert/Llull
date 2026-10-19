/** Probe-history chart as SVG text: one panel per unit, one polyline per probe on its own increments (headless "look at the curve"). */

import { timeSeriesSvg, type PlotPanel } from '@lib/timeSeriesSvg';
import type { HistorySeries } from './probeHistory';

/** Series that can be drawn: at least two increments with a finite time and value (an increment without a value is skipped, not fatal). */
const plottable = (series: readonly HistorySeries[]): HistorySeries[] =>
  series.filter((entry) => entry.points.filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value)).length >= 2);

/** SVG of the plottable series of `series`, one panel per unit; null when none is plottable. */
export function probeHistorySvg(
  series: readonly HistorySeries[],
  title: string,
  width: number,
  panelHeight: number,
): { svg: string; height: number } | null {
  const drawn = plottable(series);
  if (drawn.length === 0) return null;
  const panels: PlotPanel[] = [...new Set(drawn.map((entry) => entry.unit))].map((unit) => ({
    title: 'Probe values',
    unit,
    series: drawn
      .filter((entry) => entry.unit === unit)
      .map((entry) => ({
        label: `${entry.name} (${entry.quantity})`,
        times: entry.points.map((point) => point.time),
        values: entry.points.map((point) => point.value),
      })),
  }));
  return timeSeriesSvg(panels, { title, width, panelHeight, includeZero: false, legendOffset: 170 });
}
