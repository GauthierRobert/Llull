/** count_cycles (PHY-07 FR-FAT-05): ASTM E1049 rainflow counting of a stored history or an inline series. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { refuseFatigue } from './codes';
import { blockCycles } from './historyData';
import { countCycles as count, rainflowFourPoint, reversalsOf, totalsOf, type CountingMethod, type ResidueRule } from './rainflow';
import { historyOf } from './store';

const METHODS = ['rainflow_3pt', 'rainflow_4pt', 'rainflow_repeating'] as const;
const RESIDUES = ['half_cycles', 'repeat'] as const;

/**
 * @affects nothing; read-only, data { unit, reversals, cycles[{from,to,range,mean,count}], totals[[range,count]], residue, totalCycles }
 * @invariant exact on the input values (binSize rounds ranges up to the bin edge); full + residue half cycles of the 4-point rule equal the 3-point totals
 * @failure neither / both of historyId and history, unknown id, < 2 finite values -> FAT_HISTORY_INVALID / FAT_HISTORY_NOT_FOUND; nothing left after gating -> FAT_HISTORY_EMPTY
 */
export const countCycles = defineCommand({
  name: 'count_cycles',
  annotations: { readOnly: true },
  description:
    'Rainflow-count a load history per ASTM E1049. Give historyId (from define_load_history) OR an inline `history` array. method rainflow_3pt ' +
    '(default, E1049 5.4.4; residue counted as half cycles), rainflow_4pt (four-point rule; full cycles plus the residue, which residue ' +
    '"half_cycles" counts as half cycles) or rainflow_repeating (E1049 5.4.5 for a repeated block: all cycles are full). residue "repeat" closes ' +
    'the history as a repeating block. Returns data { reversals, cycles[{from,to,range,mean,count}], totals[[range,count]], residue, totalCycles } ' +
    'in the history unit. Example: [-2,1,-3,5,-1,3,-4,4,-2] gives totals [[3,0.5],[4,1.5],[6,0.5],[8,1],[9,0.5]].',
  params: z.object({
    historyId: z.string().optional().describe('Id of a stored history (affected[0] of define_load_history). Exclusive with `history`.'),
    history: z.array(z.number()).optional().describe('Inline series of values (>= 2). Exclusive with `historyId`.'),
    method: z.enum(METHODS).optional().describe('rainflow_3pt (default) | rainflow_4pt | rainflow_repeating.'),
    residue: z
      .enum(RESIDUES)
      .optional()
      .describe('half_cycles (default): count the residue as half cycles; repeat: close the history as a repeating block.'),
    binSize: z
      .number()
      .optional()
      .describe('Optional bin width (> 0): ranges are rounded UP to the next multiple (right-closed bins) in totals.'),
    gate: z.number().optional().describe('Optional hysteresis gate (>= 0): reversals smaller than this are dropped before counting.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, ids: string[] = [], paths: string[] = []): CommandResult =>
      refuseFatigue(doc, 'count_cycles', code, message, ids, paths);
    if ((params.historyId === undefined) === (params.history === undefined))
      return fail('FAT_HISTORY_INVALID', 'give exactly one of historyId and history', [], ['historyId']);
    if (params.binSize !== undefined && !(params.binSize > 0)) return fail('FAT_PARAMS_INVALID', 'binSize must be > 0', [], ['binSize']);
    if (params.gate !== undefined && !(params.gate >= 0)) return fail('FAT_PARAMS_INVALID', 'gate must be >= 0', [], ['gate']);
    const stored = params.historyId === undefined ? undefined : historyOf(doc, params.historyId);
    if (params.historyId !== undefined && stored === undefined)
      return fail('FAT_HISTORY_NOT_FOUND', `no history '${params.historyId}'`, [params.historyId], ['historyId']);
    const method: CountingMethod = params.method ?? 'rainflow_3pt';
    const residueRule: ResidueRule = params.residue ?? 'half_cycles';
    const gate = params.gate ?? 0;
    const unit = stored?.unit ?? '';
    const series = params.history ?? (stored?.data.form === 'series' ? stored.data.values : undefined);
    let cycles;
    let residue: number[] = [];
    let reversals: number[] = [];
    if (series === undefined && stored !== undefined) {
      cycles = blockCycles(stored, 1);
    } else {
      const values = series ?? [];
      if (values.length < 2 || values.some((value) => !Number.isFinite(value)))
        return fail('FAT_HISTORY_INVALID', 'needs >= 2 finite values', params.historyId === undefined ? [] : [params.historyId], [
          'history',
        ]);
      reversals = reversalsOf(values, gate);
      if (reversals.length < 2) return fail('FAT_HISTORY_EMPTY', 'no reversal left after gating', [], ['gate']);
      cycles = count(values, method, residueRule, gate);
      if (method === 'rainflow_4pt' && residueRule === 'half_cycles') residue = rainflowFourPoint(values, gate).residue;
    }
    const binned =
      params.binSize === undefined
        ? cycles
        : cycles.map((cycle) => ({ ...cycle, range: Math.ceil(cycle.range / (params.binSize ?? 1) - 1e-12) * (params.binSize ?? 1) }));
    const totals = totalsOf(binned);
    const totalCycles = cycles.reduce((sum, cycle) => sum + cycle.count, 0);
    return report(
      doc,
      `count_cycles: ${method}${residueRule === 'repeat' ? ' (repeat)' : ''}, ${cycles.length} cycle record(s), ${totalCycles} cycle(s) in ${totals.length} range(s)${unit === '' ? '' : ` [${unit}]`}; largest range ${totals.at(-1)?.[0] ?? 0}.`,
      { unit, method, reversals, cycles, totals, residue, totalCycles },
    );
  },
});
