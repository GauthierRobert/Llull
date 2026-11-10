/** explicit_time_history: read one requested time history of a solved explicit case (paged), numbers only from the re-verified artifact. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { analysisIdSchema } from '../shared/schemas';
import { refuseExplicit } from './codes';
import { explicitCase } from './model';
import { trustedExplicit } from './trust';

/** Most samples one call returns. */
const MAX_PAGE = 2000;

/**
 * @invariant read-only; series come from an artifact RE-VERIFIED against the recorded summary (state `solved`); a requested quantity the
 *   solver output lacks reports status EXP_TIME_HISTORY_NOT_RECORDED with no values (never an empty series); `total` is the full sample count
 * @failure unknown / non-explicit case -> FEA_ANALYSIS_NOT_FOUND / EXP_CASE_TYPE; history id / name not in the case -> EXP_TIME_HISTORY_NOT_FOUND;
 *   quantity not requested -> EXP_TIME_HISTORY_INVALID (all rejected no-ops); no verified run -> report with state and problem, no series
 */
export const explicitTimeHistory = defineCommand({
  name: 'explicit_time_history',
  annotations: { readOnly: true },
  description:
    'Read a time history requested with add_time_history from the recorded run of an explicit_dynamics case: for each quantity of the request ' +
    '(or the one named) the sample times (s) and values with their unit (vectors give [x, y, z] per sample), paged with offset and limit ' +
    `(at most ${MAX_PAGE} samples a call; \`total\` is the full count). Needs a solved, trusted run (state solved); otherwise the state and ` +
    'problem are returned without series. A quantity the solver did not record carries status EXP_TIME_HISTORY_NOT_RECORDED.',
  params: z.object({
    analysisId: analysisIdSchema,
    history: z.string().describe('Id (th-...) or name of the requested time history.'),
    quantity: z.string().optional().describe('One quantity of the request; default all of them.'),
    offset: z.number().int().min(0).optional().describe('First sample index of the page. Default 0.'),
    limit: z.number().int().min(1).max(MAX_PAGE).optional().describe(`Samples per quantity in this page. Default ${MAX_PAGE}.`),
  }),
  run: (doc, { analysisId, history, quantity, offset = 0, limit = MAX_PAGE }, ctx): CommandResult => {
    const fail = (code: string, message: string): CommandResult =>
      refuseExplicit(doc, 'explicit_time_history', code, message, [analysisId]);
    const found = explicitCase(doc, analysisId);
    if ('code' in found) return fail(found.code, found.message);
    const { spec } = found;
    const id = (spec?.timeHistoryOrder ?? []).find((key) => key === history || spec?.timeHistories?.[key]?.name === history);
    const request = id === undefined ? undefined : spec?.timeHistories?.[id];
    if (id === undefined || request === undefined)
      return fail('EXP_TIME_HISTORY_NOT_FOUND', `no time history '${history}' in '${analysisId}'`);
    if (quantity !== undefined && !request.quantities.includes(quantity))
      return fail('EXP_TIME_HISTORY_INVALID', `'${quantity}' was not requested for '${request.name}' (${request.quantities.join(', ')})`);
    const trusted = trustedExplicit(doc, found.analysisCase, ctx?.feaArtifacts);
    const base = { analysisId, historyId: id, name: request.name, kind: request.kind, state: trusted.state, problem: trusted.problem };
    if (trusted.artifact === null || trusted.summary === null)
      return report(
        doc,
        `explicit_time_history: ${id} '${request.name}' unavailable, run state ${trusted.state}${trusted.problem === null ? '' : ` (${trusted.problem.code}: ${trusted.problem.message})`}.`,
        { ...base, series: [] },
      );
    const { artifact, summary } = trusted;
    const series = (quantity === undefined ? request.quantities : [quantity]).map((name) => {
      const recorded = artifact.histories?.find((candidate) => candidate.id === id && candidate.quantity === name);
      const status =
        summary.histories?.[id]?.quantities.find((entry) => entry.quantity === name)?.status ?? 'EXP_TIME_HISTORY_NOT_RECORDED';
      if (recorded === undefined) return { quantity: name, status, total: 0, offset, t: [], values: [] };
      const components = recorded.components;
      const times = recorded.t.slice(offset, offset + limit);
      const values = Array.from({ length: times.length }, (_, index) => {
        const at = (offset + index) * components;
        return components === 1 ? (recorded.values[at] ?? 0) : recorded.values.slice(at, at + components);
      });
      return { quantity: name, status, unit: recorded.unit, components, total: recorded.t.length, offset, t: times, values };
    });
    const missing = series.filter((entry) => entry.status !== 'recorded').map((entry) => entry.quantity);
    return report(
      doc,
      `explicit_time_history: ${id} '${request.name}' ${series.map((entry) => `${entry.quantity} ${entry.total} sample(s)${'t' in entry && entry.t.length > 0 ? ` (peak |value| ${significantNumber(summary.histories?.[id]?.quantities.find((row) => row.quantity === entry.quantity)?.peakAbs ?? 0, 5)})` : ''}`).join(', ')}${missing.length > 0 ? `; EXP_TIME_HISTORY_NOT_RECORDED: ${missing.join(', ')}` : ''}.`,
      { ...base, series },
    );
  },
});
