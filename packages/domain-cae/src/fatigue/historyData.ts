/** Validation and numeric access of load histories. */

import type { LoadHistory } from '@core/model/durability';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { z } from '@core/commands/schema';
import type { Cycle } from './rainflow';

export const historyDataSchema = z.discriminatedUnion('form', [
  z.object({
    form: z.literal('series').describe('A sampled / reversal series in time order.'),
    values: z
      .array(z.number())
      .describe('At least 2 finite values in the history unit, in time order (peaks and valleys are extracted on use).'),
  }),
  z.object({
    form: z.literal('blocks').describe('Constant-amplitude blocks: each row is a cycle between max and min repeated `cycles` times.'),
    rows: z
      .array(
        z.object({
          max: z.number().describe('Maximum of the cycle, history unit.'),
          min: z.number().describe('Minimum of the cycle (<= max), history unit.'),
          cycles: z.number().describe('Number of repetitions of this cycle per block, > 0.'),
        }),
      )
      .describe('At least one row.'),
  }),
]);

export const historySourceSchema = z.object({
  citation: z.string().describe('Where the history comes from (measurement, standard, spectrum name). Mandatory, non-empty.'),
});

export const HISTORY_KINDS = ['stress', 'load_factor', 'strain'] as const;

const STRAIN_UNITS = ['m/m', 'mm/mm', 'in/in', '-', 'strain'];

/** Why a history definition is invalid, or null. */
export function historyProblem(
  kind: LoadHistory['kind'],
  unit: string,
  data: LoadHistory['data'],
  source: LoadHistory['source'],
): { readonly message: string; readonly path: string } | null {
  if (kind === 'stress' && isUnitFailure(convertValue(1, unit, 'MPa')))
    return { message: `unit '${unit}' is not a stress unit`, path: 'unit' };
  if (kind === 'load_factor' && unit.trim() !== '-') return { message: `a load_factor history has unit "-", got '${unit}'`, path: 'unit' };
  if (kind === 'strain' && !STRAIN_UNITS.includes(unit.trim()))
    return { message: `unit '${unit}' is not a strain unit (m/m, mm/mm, in/in, -)`, path: 'unit' };
  if (source.citation.trim() === '') return { message: 'source.citation is empty', path: 'source.citation' };
  if (data.form === 'series') {
    if (data.values.length < 2) return { message: `a series needs >= 2 values, got ${data.values.length}`, path: 'data.values' };
    const bad = data.values.findIndex((value) => !Number.isFinite(value));
    return bad >= 0 ? { message: `value ${bad} is not finite`, path: `data.values.${bad}` } : null;
  }
  if (data.rows.length === 0) return { message: 'blocks need >= 1 row', path: 'data.rows' };
  const bad = data.rows.findIndex(
    (row) => !(Number.isFinite(row.max) && Number.isFinite(row.min) && row.max >= row.min && row.cycles > 0 && Number.isFinite(row.cycles)),
  );
  return bad >= 0 ? { message: `row ${bad} needs finite max >= min and cycles > 0`, path: `data.rows.${bad}` } : null;
}

/** Cycles of a blocks history (one cycle per row, count = repetitions), values times `scale`. */
export const blockCycles = (history: LoadHistory, scale: number): Cycle[] =>
  history.data.form === 'blocks'
    ? history.data.rows.map((row) => ({
        from: row.min * scale,
        to: row.max * scale,
        range: Math.abs(row.max - row.min) * scale,
        mean: ((row.max + row.min) / 2) * scale,
        count: row.cycles,
      }))
    : [];
