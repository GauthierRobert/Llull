/** probe_history: read-only value-over-time of every result probe of a solved analysis (table + optional SVG plot). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { buildDeckContext } from '../decks/context';
import { historySeries } from '../results/probeHistory';
import { probeHistorySvg } from '../results/probeHistorySvg';
import { evaluateProbes } from '../results/probes';
import { caseOf } from '../shared/access';
import { refuseFe } from '../shared/feCodes';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';

const NAME = 'probe_history';
const PLOT_WIDTH = 900;
const PANEL_HEIGHT = 260;

const sig = (value: number): string => significantNumber(value, 5);

/**
 * @invariant read-only; values come from the verified results artifact (trustedRecord), per stored increment, at the same node as fea_report;
 *   points are in solver order (time in seconds; 0 for steady / static results); the SVG shares one time axis and is omitted (null) unless
 *   some probe has >= 2 increments
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; unknown probeId -> FEA_PROBE_NOT_FOUND; not solved / artifacts unavailable -> FEA_RESULTS_MISSING
 */
export const probeHistory = defineCommand({
  name: NAME,
  description:
    'Read how result probes change over time: for every stored increment of a solved analysis (heat_transient: each written time; a ' +
    'static or steady case has one) return the probe value, so heating curves and settling can be checked without a screen. data { ' +
    'analysisId, series [{ probeId, name, quantity, unit, nodeId, nodeDistance, points [{ time (s), value }], missing (increments ' +
    'without a value), start, end, min, max (each { time, value } | null) }], svg (time-series chart, one panel per unit, or null when ' +
    'no probe has two increments), width, height }. The summary lists start / end / min / max per probe. Probes come from ' +
    'add_result_probe; values are read at the nearest mesh node, in the analysis unit system (temperature in the case scale). Needs ' +
    'state solved (fea_mesh then fea_solve); fea_report gives the same values inline per load case or time. ' +
    'With the CLI, `--save plot.png` rasterizes data.svg.',
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    probeIds: z
      .array(z.string())
      .min(1)
      .optional()
      .describe('Only these probe ids (affected[0] of add_result_probe). Default every probe of the analysis.'),
    plot: z.boolean().optional().describe('Draw data.svg. Default true; false returns the numbers only.'),
    width: z.number().int().min(320).max(3000).optional().describe('Chart width in px. Default 900.'),
  }),
  run: (doc, { analysisId, probeIds, plot = true, width = PLOT_WIDTH }, ctx): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined) return refuseFe(doc, NAME, 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
    const unknown = (probeIds ?? []).filter((id) => !Object.hasOwn(analysisCase.probes, id));
    if (unknown.length > 0)
      return refuseFe(doc, NAME, 'FEA_PROBE_NOT_FOUND', `no probe ${unknown.map((id) => `'${id}'`).join(', ')} in '${analysisId}'`, [
        analysisId,
        ...unknown,
      ]);
    const { state, meshArtifact: mesh, resultsArtifact: results } = trustedRecord(doc, analysisCase, ctx?.feaArtifacts);
    if (mesh === null || results === null)
      return refuseFe(
        doc,
        NAME,
        'FEA_RESULTS_MISSING',
        `no verified results for '${analysisId}' (state ${state}); run fea_mesh then fea_solve`,
        [analysisId],
      );
    const lengthToAnalysis = buildDeckContext(doc, analysisId, mesh)?.lengthToAnalysis ?? 1;
    const series = historySeries(evaluateProbes(analysisCase, mesh, results, lengthToAnalysis), probeIds);
    const chart = plot ? probeHistorySvg(series, `${analysisCase.name}: probe history`, width, PANEL_HEIGHT) : null;
    const lines = series.map((entry) =>
      entry.start === null || entry.end === null || entry.min === null || entry.max === null
        ? `${entry.name} (${entry.quantity}): no values`
        : `${entry.name} (${entry.quantity}) ${entry.points.length} increment(s): start ${sig(entry.start.value)} @${sig(entry.start.time)} s, end ${sig(entry.end.value)} @${sig(entry.end.time)} s, min ${sig(entry.min.value)} @${sig(entry.min.time)} s, max ${sig(entry.max.value)} @${sig(entry.max.time)} s ${entry.unit}`,
    );
    return report(
      doc,
      `${NAME}: '${analysisId}' ${series.length} probe(s)${lines.length > 0 ? `; ${lines.join('; ')}` : ' (none defined: add_result_probe)'}.`,
      { analysisId, series, svg: chart?.svg ?? null, width: chart === null ? null : width, height: chart?.height ?? null },
    );
  },
});
