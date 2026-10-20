/** fea_result_field: a result field at nodes / points / probes of a solved analysis, read from the verified results artifact. */

import { defineCommand, vec3, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { buildDeckContext } from '../decks/context';
import { RESULT_FIELDS, resultField } from '../results/resultField';
import { caseOf } from '../shared/access';
import { refuseFe } from '../shared/feCodes';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';

const NAME = 'fea_result_field';
/** Rows returned at most (the statistics always cover the whole result set). */
const MAX_ROWS = 500;

/**
 * @invariant read-only; values come from the verified results artifact (trustedRecord), never from the recorded summary; statistics are over every node with a value
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; no verified results (unsolved, stale, artifact missing) -> FEA_RESULTS_MISSING; no such load case / mode ->
 *   FEA_RESULTS_MISSING; field absent from the result set (e.g. stress of a modal case) -> FEA_FIELD_MISSING; more than one of nodes / points / probes -> FEA_PARAM_INVALID
 */
export const feaResultField = defineCommand({
  name: NAME,
  description:
    'Read one result field of a SOLVED analysis as numbers: von_mises, u_mag, u_x, u_y, u_z, s_xx, s_yy, s_zz (heat cases: temperature, heat_flux) for a ' +
    'load case (loadCase, default the first) or a mode (mode, 1-based, modal / buckling: displacement of the mode shape, whose amplitude is arbitrary). ' +
    'Returns data { field, unit, resultSet, count, min { value, node, at }, max { value, node, at }, mean, rows [{ node, at, value, entityId, distance? }] }; ' +
    'min / max / mean cover every node of the result set. rows are the `limit` (default 20, max 500) nodes with the largest (or smallest, order) value, OR the ' +
    'nodes you name (nodes: mesh node ids), OR the nearest node to each of `points` (document units), OR the nearest node to each result probe (probes: true); ' +
    'give at most one of them. Values are nodal (the solver averages stress at shared nodes) in the analysis unitSystem (N-mm-t-s: MPa, mm); `at` and distance are ' +
    'in the analysis length unit. Singular spots (point loads, supports, re-entrant corners) read high: judge them. Requires fea_mesh and fea_solve on this machine.',
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    field: z
      .enum(RESULT_FIELDS as [string, ...string[]])
      .describe('Field to read: von_mises | u_mag | u_x | u_y | u_z | s_xx | s_yy | s_zz | temperature | heat_flux.'),
    loadCase: z.string().optional().describe('Load case name (static / thermo-mechanical). Default: the first load case.'),
    mode: z.number().int().min(1).optional().describe('modal / buckling only: mode number, 1-based. Default 1.'),
    nodes: z
      .array(z.number().int())
      .max(MAX_ROWS)
      .optional()
      .describe('Mesh node ids to read (see describe_analysis / fea_report for positions). At most 500.'),
    points: z
      .array(vec3('A point [x, y, z] in document units; the nearest mesh node is read.'))
      .max(MAX_ROWS)
      .optional()
      .describe('Points in document units; the nearest node to each is read.'),
    probes: z.boolean().optional().describe('true = read the node nearest to each result probe of the analysis (add_result_probe).'),
    order: z.enum(['largest', 'smallest']).optional().describe('Extremes only: rank the nodes by largest (default) or smallest value.'),
    limit: z.number().int().min(1).max(MAX_ROWS).optional().describe('Extremes only: how many nodes to return (default 20, max 500).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { analysisId } = params;
    const analysis = caseOf(doc, analysisId);
    if (analysis === undefined) return refuseFe(doc, NAME, 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
    const selections = [params.nodes, params.points, params.probes === true ? true : undefined].filter((entry) => entry !== undefined);
    if (selections.length > 1) return refuseFe(doc, NAME, 'FEA_PARAM_INVALID', 'give at most one of nodes, points, probes', [analysisId]);
    const trust = trustedRecord(doc, analysis, ctx?.feaArtifacts);
    const { meshArtifact: mesh, resultsArtifact: results } = trust;
    if (mesh === null || results === null)
      return refuseFe(
        doc,
        NAME,
        'FEA_RESULTS_MISSING',
        `analysis '${analysisId}' has no verified results (state ${trust.state}${trust.problem === null ? '' : `: ${trust.problem.message}`})`,
        [analysisId],
      );
    const lengthToAnalysis = buildDeckContext(doc, analysisId, mesh)?.lengthToAnalysis ?? 1;
    const data = resultField(
      analysis,
      mesh,
      results,
      {
        field: params.field as (typeof RESULT_FIELDS)[number],
        loadCase: params.loadCase,
        mode: params.mode,
        nodes: params.nodes,
        points: params.points?.map(
          (point) => [point[0] * lengthToAnalysis, point[1] * lengthToAnalysis, point[2] * lengthToAnalysis] as const,
        ),
        probes: params.probes,
        order: params.order ?? 'largest',
        limit: params.limit ?? 20,
      },
      lengthToAnalysis,
    );
    if ('code' in data) return refuseFe(doc, NAME, data.code, data.message, [analysisId]);
    const peak = data.max === null ? 'no values' : `max ${significantNumber(data.max.value, 6)} ${data.unit} at node ${data.max.node}`;
    return report(
      doc,
      `fea_result_field: ${params.field} of '${analysisId}' (${data.resultSet}): ${data.count} node(s), ${peak}${data.min === null ? '' : `, min ${significantNumber(data.min.value, 6)}`}; ${data.rows.length} row(s) (${data.selection}).${data.missingNodes.length > 0 ? ` Nodes without a value: ${data.missingNodes.join(', ')}.` : ''}`,
      { analysisId, ...data },
    );
  },
});
