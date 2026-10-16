/** thermal_report: temperatures, heat flows and heat balance of a solved heat_* analysis, as data (PHY-03 FR-THM-11, FR-THM-12, AF-10). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { analysisIdSchema } from '../shared/schemas';
import { stateOf } from '../shared/state';
import { isProblem, thermalCaseOf } from './access';
import { REVIEW_REASON } from './check';
import { refuseThermal } from './codes';
import { HEAT_BALANCE_TOLERANCE, hasRadiation, physicalConstantsOf } from './constants';
import { unverifiedInputs } from './unverified';

/**
 * @invariant read-only; numbers appear only when the recorded results are current (state solved); unverified is the OR of the k / cp /
 *   density input flags; physical constants are named with source and defaulted when radiation exists
 * @failure unknown analysis / other case type -> refusal (FEA_ANALYSIS_NOT_FOUND / THM_CASE_TYPE)
 */
export const thermalReport = defineCommand({
  name: 'thermal_report',
  description:
    'Read the thermal results of a heat_steady / heat_transient analysis: data { state: unmeshed | meshed | solved | stale | missing, ' +
    'temperatureScale, maxT / minT {value, at (document units), entityId, timeS}, maxHeatFlux, bcHeatFlows [{ bcId, timeS, valueW }] (W, ' +
    'positive INTO the part), heatBalance {inW, outW, storedW, residualRel, timeS, tolerance}, probes [{ probeId, series [[timeS, T]] }], ' +
    'physicalConstants (radiation cases: Stefan-Boltzmann and absolute zero with source and defaulted), propertyRangeExceeded, unverified, ' +
    'unverifiedReasons }. Numbers are returned only for state "solved": a stale result must be re-solved (fea_mesh, fea_solve). ' +
    'Check heatBalance.residualRel against the tolerance before reporting a result as final; end with check_thermal.',
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    timeS: z.number().optional().describe('Report the per-BC heat flows at the result time nearest to this (seconds). Default: the last.'),
    probes: z.array(z.string()).optional().describe('Only these probe ids. Default: all temperature probes.'),
  }),
  run: (doc, { analysisId, timeS, probes }, ctx): CommandResult => {
    const found = thermalCaseOf(doc, analysisId);
    if (isProblem(found)) return refuseThermal(doc, 'thermal_report', found.code, found.message, found.ids, found.paths);
    const { analysisCase, thermal } = found;
    const base = stateOf(doc, analysisCase);
    const port = ctx?.feaArtifacts ?? null;
    const absent =
      port !== null &&
      ((analysisCase.meshSummary !== undefined && port.get(analysisCase.meshSummary.meshHash) === null) ||
        (analysisCase.results !== undefined && port.get(analysisCase.results.resultsHash) === null));
    const state = base === 'unmeshed' || base === 'stale' ? base : absent ? 'missing' : base;
    const inputs = unverifiedInputs(doc, found);
    const summary = analysisCase.results?.thermal;
    const header = {
      analysisId,
      state,
      temperatureScale: thermal.temperatureScale,
      unverified: inputs.unverified,
      unverifiedReasons: inputs.reasons,
    };
    if (summary === undefined || state === 'stale' || state === 'unmeshed' || state === 'meshed') {
      const why = state === 'stale' ? 'results are stale: re-run fea_mesh and fea_solve' : 'no results yet: run fea_mesh and fea_solve';
      return report(doc, `thermal_report: '${analysisId}' — ${state} (${why}).`, { ...header, message: why });
    }
    const times = summary.times;
    const wanted =
      timeS === undefined
        ? (times[times.length - 1] ?? 0)
        : times.reduce((best, t) => (Math.abs(t - timeS) < Math.abs(best - timeS) ? t : best), times[0] ?? 0);
    const balance = summary.heatBalance;
    const data = {
      ...header,
      times,
      maxT: summary.maxT,
      minT: summary.minT,
      maxHeatFlux: summary.maxHeatFluxW_m2,
      reportedTimeS: wanted,
      bcHeatFlows: summary.bcHeatFlowsW.filter((flow) => flow.timeS === wanted),
      heatBalance: { ...balance, tolerance: HEAT_BALANCE_TOLERANCE, withinTolerance: balance.residualRel <= HEAT_BALANCE_TOLERANCE.value },
      probes: summary.probes.filter((probe) => probes === undefined || probes.includes(probe.probeId)),
      physicalConstants: summary.physicalConstants ?? (hasRadiation(thermal) ? physicalConstantsOf(thermal.temperatureScale) : null),
      propertyRangeExceeded: summary.propertyRangeExceeded,
      fieldRefs: summary.fieldRefs,
      reviewRequired: true,
      reviewReason: REVIEW_REASON,
    };
    const unit = thermal.temperatureScale;
    const text = [
      `thermal_report: '${analysisId}' ${state}`,
      `max ${summary.maxT.value} ${unit} at [${summary.maxT.at.join(', ')}] t=${summary.maxT.timeS} s`,
      `min ${summary.minT.value} ${unit}`,
      `heat balance residual ${balance.residualRel} (in ${balance.inW} W, out ${balance.outW} W, stored ${balance.storedW} W)${data.heatBalance.withinTolerance ? '' : ' EXCEEDS the tolerance: do not report as final'}`,
      inputs.unverified ? `unverified inputs: ${inputs.reasons.join('; ')}` : 'no unverified input',
    ];
    return report(doc, `${text.join('; ')}.`, data);
  },
});
