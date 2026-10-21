/** analysis_report: the read-only results report of an analysis; one command, the view follows the analysis type. */

import type { AnalysisCase } from '@core/model/analysis';
import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { dynamicResultsReport } from '../dynamics/reportCommands';
import { explicitResultsReport } from '../explicit/queries';
import { caseOf } from '../shared/access';
import { refuseCode } from '../shared/codes';
import { analysisIdSchema } from '../shared/schemas';
import { thermalResultsReport } from '../thermal/report';
import { feaStatusReport } from './report';

const NAME = 'analysis_report';
const VIEWS = ['status', 'thermal', 'explicit', 'dynamic'] as const;
type View = (typeof VIEWS)[number];

const defaultView = (type: AnalysisCase['type']): View =>
  type === 'heat_steady' || type === 'heat_transient'
    ? 'thermal'
    : type === 'explicit_dynamics'
      ? 'explicit'
      : type === 'frequency_response' || type === 'random_response'
        ? 'dynamic'
        : 'status';

/**
 * @invariant read-only; every number is recomputed from the artifact store (state unmeshed | meshed | solved | stale | missing | untrusted);
 *   the view defaults from the analysis type (heat_* thermal, explicit_dynamics explicit, frequency/random_response dynamic, else status)
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; timeS / probes / maxPoints that the chosen view does not read -> FEA_PARAM_NOT_APPLICABLE;
 *   a view that does not fit the analysis type -> THM_CASE_TYPE / EXP_CASE_TYPE / DYN_CASE_TYPE
 */
export const analysisReport = defineCommand({
  name: NAME,
  description:
    'Read the RESULTS of an analysis (describe_analysis reads its set-up and ids). Every number is recomputed from the artifact store; a stale ' +
    'result must be re-run, "missing" and "untrusted" (FEA_SUMMARY_MISMATCH) states withhold numbers. The view follows the analysis type. ' +
    'status (static, modal, buckling, nonlinear_static, thermo_static, coupled_temperature_displacement): data { state: unmeshed | meshed | solved | stale | missing | ' +
    'untrusted, unitSystem, mesh (node and element counts, quality, warnings), results (per load case max von Mises and max displacement with ' +
    'positions and units, or the thermal summary), eigen (modal: modes [{ mode, frequencyHz, participation, effectiveMass, fractionOfModelMass }], ' +
    'totalEffectiveMass, rigidBodyModes; buckling: factors, criticalFactor, criticalMode; null otherwise), problem, probes [{ probeId, quantity, ' +
    'unit, nodeId, nodeDistance, values }] at the nearest mesh node }. ' +
    'thermal (heat_steady, heat_transient; view "thermal" also on coupled_temperature_displacement): maxT / minT {value, at, entityId, timeS}, maxHeatFlux, ' +
    'bcHeatFlows [{ bcId, timeS, valueW }] (positive INTO the part), heatBalance {inW, outW, storedW, residualRel, tolerance, withinTolerance} (check it ' +
    'before reporting a result as final), probes, heatFluxProbes, physicalConstants, propertyRangeExceeded, unverified; params timeS (seconds, nearest ' +
    'result time for bcHeatFlows, default last) and probes (probe ids) apply; end with check_thermal. ' +
    'explicit (explicit_dynamics): state, controls with named defaults, initial velocities, rigid walls and, when solved, termination, cycles, ' +
    'energies and energy error, hourglass and added-mass ratios, max von Mises and plastic strain with location, failed elements, per-wall peak ' +
    'force and impulse, energy and wall-force histories; param maxPoints (2 to 500, default 200) applies. ' +
    'dynamic (frequency_response, random_response): summary { modesKept, massParticipation, dampingPerMode, probes (frf peaks / random rms and ' +
    '3-sigma peak), nodalMax, unverified }; param probes (probe names) applies. ' +
    'Set view to read a case in another view (e.g. status on a heat_* case). thermal, explicit and dynamic results are reviewRequired: report them as ' +
    '"computed by llull, not approved". Topology studies are read with topology_report.',
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    view: z
      .enum(VIEWS)
      .optional()
      .describe(
        'Which report. Default from the analysis type: heat_* thermal, explicit_dynamics explicit, frequency_response / random_response dynamic, else status.',
      ),
    timeS: z
      .number()
      .optional()
      .describe('thermal view only: report the per-BC heat flows at the result time nearest to this (seconds). Default: the last.'),
    probes: z
      .array(z.string())
      .optional()
      .describe(
        'thermal view: only these probe ids (default all temperature and heat_flux probes); dynamic view: only these probe names (default all).',
      ),
    maxPoints: z.number().int().optional().describe('explicit view only: most samples per history, 2 to 500. Default 200.'),
  }),
  run: (doc, { analysisId, view, timeS, probes, maxPoints }, ctx): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseCode(doc, NAME, 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
    const chosen = view ?? defaultView(analysisCase.type);
    const misplaced = [
      timeS !== undefined && chosen !== 'thermal' ? `timeS (thermal view only; this report is '${chosen}')` : null,
      maxPoints !== undefined && chosen !== 'explicit' ? `maxPoints (explicit view only; this report is '${chosen}')` : null,
      probes !== undefined && chosen !== 'thermal' && chosen !== 'dynamic'
        ? `probes (thermal and dynamic views only; this report is '${chosen}')`
        : null,
    ].filter((entry): entry is string => entry !== null);
    if (misplaced.length > 0)
      return refuseCode(
        doc,
        NAME,
        'FEA_PARAM_NOT_APPLICABLE',
        `${misplaced.join('; ')} for '${analysisId}' (${analysisCase.type}); drop it or pick a view that reads it`,
        [analysisId],
        ['view'],
      );
    if (chosen === 'thermal') return thermalResultsReport(doc, { analysisId, timeS, probes }, ctx);
    if (chosen === 'explicit') return explicitResultsReport(doc, { analysisId, maxPoints }, ctx);
    if (chosen === 'dynamic') return dynamicResultsReport(doc, { analysisId, probes }, ctx);
    return feaStatusReport(doc, { analysisId }, ctx);
  },
});
