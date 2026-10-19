/** Probe history: the value of each result probe at every stored increment (time, value), with start / end / min / max. */

import type { ProbeReading } from './probes';

interface HistoryPoint {
  readonly time: number;
  readonly value: number;
}

export interface HistorySeries {
  readonly probeId: string;
  readonly name: string;
  readonly quantity: string;
  readonly unit: string;
  readonly nodeId: number | null;
  readonly nodeDistance: number | null;
  /** One point per stored increment that has a finite value, in solver order. */
  readonly points: readonly HistoryPoint[];
  /** Increments stored for the case but without a value for this probe (field not written there). */
  readonly missing: number;
  readonly start: HistoryPoint | null;
  readonly end: HistoryPoint | null;
  readonly min: HistoryPoint | null;
  readonly max: HistoryPoint | null;
}

/** Series of the probes of `readings` (all of them, or only `probeIds`), keeping the increments that have a value. */
export function historySeries(readings: readonly ProbeReading[], probeIds?: readonly string[]): HistorySeries[] {
  return readings
    .filter((reading) => probeIds === undefined || probeIds.includes(reading.probeId))
    .map((reading) => {
      const points: HistoryPoint[] = reading.values.flatMap(({ time, value }) =>
        value === null || !Number.isFinite(value) || !Number.isFinite(time) ? [] : [{ time, value }],
      );
      let min: HistoryPoint | null = null;
      let max: HistoryPoint | null = null;
      for (const point of points) {
        if (min === null || point.value < min.value) min = point;
        if (max === null || point.value > max.value) max = point;
      }
      return {
        probeId: reading.probeId,
        name: reading.name,
        quantity: reading.quantity,
        unit: reading.unit,
        nodeId: reading.nodeId,
        nodeDistance: reading.nodeDistance,
        points,
        missing: reading.values.length - points.length,
        start: points[0] ?? null,
        end: points[points.length - 1] ?? null,
        min,
        max,
      };
    });
}
