/** define_load_history / update_load_history / delete_load_history (PHY-07 FR-FAT-05): load, stress and strain histories of the durability slice. */

import type { LoadHistory } from '@core/model/durability';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { refuseFatigue } from './codes';
import { HISTORY_KINDS, historyDataSchema, historyProblem, historySourceSchema } from './historyData';
import { durabilityOf, historyOf, withHistory, withoutHistory } from './store';

const REPEATS = ['once', 'repeating'] as const;

/**
 * @affects doc.analysis.durability.histories (adds 1 history; affected: [historyId])
 * @invariant ids `lh-<step>.<k>`; stress unit is a stress, load_factor unit is "-", series has >= 2 finite values, blocks have max >= min and cycles > 0
 * @failure invalid values / unit / empty citation -> FAT_HISTORY_INVALID (unchanged doc)
 */
export const defineLoadHistory = defineCommand({
  name: 'define_load_history',
  description:
    'Define a load, stress or strain history for fatigue and crack growth. data.form "series" is a time-ordered list of values (peaks and valleys ' +
    'are extracted on use); "blocks" lists constant-amplitude cycles {max, min, cycles} per block. kind "stress" carries stresses in `unit` (MPa, ksi, ...), ' +
    '"load_factor" is dimensionless (unit "-") and scales an FE load case, "strain" is a strain. repeats "repeating" means the block is repeated until failure ' +
    '(ASTM E1049 5.4.5). source.citation is mandatory. Returns the history id in affected[0]. Next: count_cycles, create_fatigue_case or create_crack_growth_case.',
  params: z.object({
    name: z.string().min(1).describe('Display name of the history, e.g. "flight block 1".'),
    kind: z.enum(HISTORY_KINDS).describe('stress | load_factor | strain.'),
    unit: z.string().describe('Unit of the values: a stress unit (MPa, ksi) for stress, "-" for load_factor, m/m (or -) for strain.'),
    data: historyDataSchema.describe('The values: { form: "series", values: [...] } or { form: "blocks", rows: [{ max, min, cycles }] }.'),
    repeats: z.enum(REPEATS).optional().describe('once (default) or repeating (the block is repeated until failure).'),
    source: historySourceSchema.describe('Provenance of the history (required).'),
  }),
  run: (doc, params): CommandResult => {
    const problem = historyProblem(params.kind, params.unit, params.data, params.source);
    if (problem !== null) return refuseFatigue(doc, 'define_load_history', 'FAT_HISTORY_INVALID', problem.message, [], [problem.path]);
    const id = nextId('lh');
    const history: LoadHistory = {
      id,
      name: params.name,
      kind: params.kind,
      unit: params.unit,
      data: params.data,
      repeats: params.repeats ?? 'once',
      source: params.source,
    };
    const size = history.data.form === 'series' ? `${history.data.values.length} values` : `${history.data.rows.length} block row(s)`;
    return changed(
      withHistory(doc, history),
      `Defined load history ${id} '${params.name}' (${params.kind}, ${params.unit}, ${size}, ${history.repeats}).`,
      [id],
    );
  },
});

/**
 * @affects doc.analysis.durability.histories[historyId] (replaces the given fields)
 * @failure unknown id -> FAT_HISTORY_NOT_FOUND; an invalid merged definition -> FAT_HISTORY_INVALID (unchanged doc)
 */
export const updateLoadHistory = defineCommand({
  name: 'update_load_history',
  description:
    'Change fields of a load history (name, unit, data, repeats, source); omitted fields keep their value. The merged history must be valid ' +
    '(see define_load_history). Fatigue and crack-growth cases that use the history see the new values on their next compute.',
  params: z.object({
    historyId: z.string().describe('History id (affected[0] of define_load_history).'),
    name: z.string().min(1).optional().describe('New display name.'),
    unit: z.string().optional().describe('New unit (must match the kind).'),
    data: historyDataSchema.optional().describe('New values.'),
    repeats: z.enum(REPEATS).optional().describe('once | repeating.'),
    source: historySourceSchema.optional().describe('New provenance.'),
  }),
  run: (doc, params): CommandResult => {
    const current = historyOf(doc, params.historyId);
    if (current === undefined)
      return refuseFatigue(
        doc,
        'update_load_history',
        'FAT_HISTORY_NOT_FOUND',
        `no history '${params.historyId}'`,
        [params.historyId],
        ['historyId'],
      );
    const next: LoadHistory = {
      ...current,
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.unit !== undefined ? { unit: params.unit } : {}),
      ...(params.data !== undefined ? { data: params.data } : {}),
      ...(params.repeats !== undefined ? { repeats: params.repeats } : {}),
      ...(params.source !== undefined ? { source: params.source } : {}),
    };
    const problem = historyProblem(next.kind, next.unit, next.data, next.source);
    if (problem !== null)
      return refuseFatigue(doc, 'update_load_history', 'FAT_HISTORY_INVALID', problem.message, [params.historyId], [problem.path]);
    return changed(withHistory(doc, next), `Updated load history ${next.id} '${next.name}' (${next.unit}, ${next.repeats}).`, [next.id]);
  },
});

/**
 * @affects doc.analysis.durability.histories (removes 1 history)
 * @failure unknown id -> FAT_HISTORY_NOT_FOUND; used by a fatigue or crack-growth case -> FAT_HISTORY_IN_USE (unchanged doc)
 */
export const deleteLoadHistory = defineCommand({
  name: 'delete_load_history',
  description: 'Delete a load history that no fatigue case or crack-growth case uses (refused with FAT_HISTORY_IN_USE otherwise).',
  annotations: { destructive: true },
  params: z.object({ historyId: z.string().describe('History id to delete.') }),
  run: (doc, params): CommandResult => {
    if (historyOf(doc, params.historyId) === undefined)
      return refuseFatigue(
        doc,
        'delete_load_history',
        'FAT_HISTORY_NOT_FOUND',
        `no history '${params.historyId}'`,
        [params.historyId],
        ['historyId'],
      );
    const d = durabilityOf(doc);
    const users = [
      ...Object.values(d.fatigueCases)
        .filter((c) => c.mapping.some((m) => m.historyId === params.historyId))
        .map((c) => c.id),
      ...Object.values(d.crackGrowthCases)
        .filter((c) => c.histories.some((h) => h.historyId === params.historyId))
        .map((c) => c.id),
    ];
    if (users.length > 0)
      return refuseFatigue(
        doc,
        'delete_load_history',
        'FAT_HISTORY_IN_USE',
        `history is used by ${users.join(', ')}`,
        [params.historyId, ...users],
        ['historyId'],
      );
    return changed(withoutHistory(doc, params.historyId), `Deleted load history ${params.historyId}.`, [params.historyId]);
  },
});
