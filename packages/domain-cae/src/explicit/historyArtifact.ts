/** The recorded time-history series of an explicit run (`histories.json` of the job) and their bounded summary. */

import type { ExplicitHistorySeries, ExplicitHistorySummary, ExplicitSpec, FeExplicitArtifact } from '@core/model/explicit';
import { isRecord } from '@lib/isRecord';
import { historyUnit, type JobTimeHistory } from './historyJob';

interface Units {
  readonly length: string;
  readonly energy: string;
}

const isNumbers = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));

/**
 * The series of `histories.json` that answer the job's requests, as artifact series (units from the case units). A series of a request the
 * solver did not record is simply absent (the summary then flags it EXP_TIME_HISTORY_NOT_RECORDED); null `text` = no file.
 * @failure not JSON, wrong shape, values not `components` per time, times not strictly increasing, or an unrequested series -> explanation string
 */
export function parseHistorySeries(
  text: string | null,
  requests: readonly JobTimeHistory[],
  units: Units,
): ExplicitHistorySeries[] | string {
  if (text === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'histories.json is not JSON';
  }
  const rows = isRecord(value) && Array.isArray(value['series']) ? value['series'] : null;
  if (rows === null) return 'histories.json has no series list';
  const found: ExplicitHistorySeries[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row['name'] !== 'string' || typeof row['quantity'] !== 'string')
      return 'histories.json: a series lacks name or quantity';
    const { name, quantity, components, times, values } = row;
    if ((components !== 1 && components !== 3) || !isNumbers(times) || !isNumbers(values) || values.length !== components * times.length)
      return `histories.json: series '${name}' ${quantity} has malformed times / values`;
    if (times.some((time, index) => index > 0 && !(time > (times[index - 1] ?? 0))))
      return `histories.json: series '${name}' ${quantity} times are not increasing`;
    const request = requests.find((candidate) => candidate.name === name && candidate.quantities.includes(quantity));
    if (request === undefined) return `histories.json: series '${name}' ${quantity} was not requested`;
    found.push({ id: request.id, name, quantity, components, unit: historyUnit(quantity, units), t: times, values });
  }
  return found;
}

/** Per requested history id: each requested quantity recorded or flagged `EXP_TIME_HISTORY_NOT_RECORDED`; undefined without any request. */
export function historySummary(
  spec: ExplicitSpec | undefined,
  artifact: FeExplicitArtifact,
  units: Units,
): Readonly<Record<string, ExplicitHistorySummary>> | undefined {
  const order = spec?.timeHistoryOrder ?? [];
  if (order.length === 0) return undefined;
  const entries = order.flatMap((id) => {
    const request = spec?.timeHistories?.[id];
    if (request === undefined) return [];
    const quantities = request.quantities.map((quantity) => {
      const series = artifact.histories?.find((candidate) => candidate.id === id && candidate.quantity === quantity);
      const unit = historyUnit(quantity, units);
      if (series === undefined) return { quantity, unit, status: 'EXP_TIME_HISTORY_NOT_RECORDED' as const, samples: 0, peakAbs: 0 };
      return {
        quantity,
        unit,
        status: 'recorded' as const,
        samples: series.t.length,
        peakAbs: series.values.reduce((largest, entry) => Math.max(largest, Math.abs(entry)), 0),
      };
    });
    return [[id, { name: request.name, quantities }] as const];
  });
  return Object.fromEntries(entries);
}
