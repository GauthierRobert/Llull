/** thermal_report: temperatures, heat flows and heat balance of a solved heat_* analysis, as data (PHY-03 FR-THM-11, FR-THM-12, AF-10). */

import { significantNumber } from '@lib/compactNumber';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { evaluateProbes } from '../results/probes';
import { buildDeckContext } from '../decks/context';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';
import { isProblem, thermalCaseOf } from './access';
import { REVIEW_REASON } from './check';
import { refuseThermal } from './codes';
import { HEAT_BALANCE_TOLERANCE, hasRadiation, physicalConstantsOf } from './constants';
import { unverifiedInputs } from './unverified';

/**
 * @invariant read-only; numbers appear only when the recorded results are current AND re-verified against the artifact store (state solved;
 *   no store, a missing artifact or a summary that differs from its artifact withholds them: state missing / untrusted); unverified is the OR of the k / cp /
 *   density input flags; physical constants are named with source and defaulted when radiation exists
 * @failure unknown analysis / other case type -> refusal (FEA_ANALYSIS_NOT_FOUND / THM_CASE_TYPE)
 */
export const thermalReport = defineCommand({
  name: 'thermal_report',
  description:
    'Read the thermal results of a heat_steady / heat_transient analysis: data { state: unmeshed | meshed | solved | stale | missing | untrusted, ' +
    'temperatureScale, maxT / minT {value, at (document units), entityId, timeS}, maxHeatFlux {value, unit W/m^2, at, timeS}, bcHeatFlows [{ bcId, timeS, valueW }] (W, ' +
    'positive INTO the part), heatBalance {inW, outW, storedW, residualRel, timeS, tolerance}, probes [{ probeId, series [[timeS, T]] }], heatFluxProbes [{ probeId, name, unit W/m^2, nodeId, nodeDistance, values [{ time, value }] }] (heat_flux probes, value = flux magnitude at the nearest node), ' +
    'physicalConstants (radiation cases: Stefan-Boltzmann and absolute zero with source and defaulted), propertyRangeExceeded, unverified, ' +
    'unverifiedReasons }. Numbers are returned only for state "solved" and are recomputed from the artifact store: a stale result must be re-solved (fea_mesh, ' +
    'fea_solve); "missing" (no artifact store or artifact on this machine) and "untrusted" (FEA_SUMMARY_MISMATCH) withhold them. ' +
    "Check heatBalance.residualRel against the tolerance before reporting a result as final (samplingRel = spread between the end-value and interval-mean quadratures of a transient's last output interval; above the tolerance, write results at every increment); end with check_thermal.",
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    timeS: z.number().optional().describe('Report the per-BC heat flows at the result time nearest to this (seconds). Default: the last.'),
    probes: z.array(z.string()).optional().describe('Only these probe ids. Default: all temperature and heat_flux probes.'),
  }),
  run: (doc, { analysisId, timeS, probes }, ctx): CommandResult => {
    const found = thermalCaseOf(doc, analysisId);
    if (isProblem(found)) return refuseThermal(doc, 'thermal_report', found.code, found.message, found.ids, found.paths);
    const { analysisCase, thermal } = found;
    const trust = trustedRecord(doc, analysisCase, ctx?.feaArtifacts);
    const { state } = trust;
    const inputs = unverifiedInputs(doc, found);
    const summary = trust.results?.thermal;
    const header = {
      analysisId,
      state,
      temperatureScale: thermal.temperatureScale,
      unverified: inputs.unverified,
      unverifiedReasons: inputs.reasons,
      problem: trust.problem,
    };
    if (summary === undefined || state !== 'solved') {
      const why =
        state === 'stale'
          ? 'results are stale: re-run fea_mesh and fea_solve'
          : state === 'untrusted'
            ? `FEA_SUMMARY_MISMATCH: ${trust.problem?.message ?? 'the recorded summary differs from its artifact'}; numbers withheld`
            : state === 'missing'
              ? `${trust.problem?.message ?? 'the artifact is not available on this machine'}; numbers withheld`
              : 'no results yet: run fea_mesh and fea_solve';
      return report(doc, `thermal_report: '${analysisId}' — ${state} (${why}).`, { ...header, message: why });
    }
    const times = summary.times;
    const wanted =
      timeS === undefined
        ? (times[times.length - 1] ?? 0)
        : times.reduce((best, t) => (Math.abs(t - timeS) < Math.abs(best - timeS) ? t : best), times[0] ?? 0);
    const balance = summary.heatBalance;
    const mesh = trust.meshArtifact;
    const results = trust.resultsArtifact;
    const lengthToAnalysis = mesh === null ? 1 : (buildDeckContext(doc, analysisId, mesh)?.lengthToAnalysis ?? 1);
    const heatFluxProbes =
      mesh === null || results === null
        ? []
        : evaluateProbes(analysisCase, mesh, results, lengthToAnalysis)
            .filter((reading) => reading.quantity === 'heat_flux' && (probes === undefined || probes.includes(reading.probeId)))
            .map((reading) => ({ ...reading, values: reading.values.map(({ time, value }) => ({ time, value })) }));
    const data = {
      ...header,
      times,
      maxT: summary.maxT,
      minT: summary.minT,
      maxHeatFlux: { ...summary.maxHeatFluxW_m2, unit: 'W/m^2' },
      reportedTimeS: wanted,
      bcHeatFlows: summary.bcHeatFlowsW.filter((flow) => flow.timeS === wanted),
      heatBalance: { ...balance, tolerance: HEAT_BALANCE_TOLERANCE, withinTolerance: balance.residualRel <= HEAT_BALANCE_TOLERANCE.value },
      probes: summary.probes
        .filter((probe) => probes === undefined || probes.includes(probe.probeId))
        .map((probe) => ({ ...probe, name: analysisCase.probes[probe.probeId]?.name ?? probe.probeId })),
      heatFluxProbes,
      physicalConstants: summary.physicalConstants ?? (hasRadiation(thermal) ? physicalConstantsOf(thermal) : null),
      propertyRangeExceeded: summary.propertyRangeExceeded,
      fieldRefs: summary.fieldRefs,
      reviewRequired: true,
      reviewReason: REVIEW_REASON,
    };
    const unit = thermal.temperatureScale;
    const sig = (value: number): string => significantNumber(value, 5);
    const steady = analysisCase.type === 'heat_steady';
    const fluxText = heatFluxProbes.map(
      (probe) => `heat flux probe ${probe.name} ${probe.values.map(({ value }) => (value === null ? 'n/a' : sig(value))).join(', ')} W/m^2`,
    );
    const text = [
      `thermal_report: '${analysisId}' ${state}`,
      `max ${sig(summary.maxT.value)} ${unit} at [${summary.maxT.at.map(sig).join(', ')}] ${steady ? 'steady state' : `t=${sig(summary.maxT.timeS)} s`}`,
      `min ${sig(summary.minT.value)} ${unit}`,
      `heat balance residual ${sig(balance.residualRel)}${balance.samplingRel === undefined ? '' : ` (± ${sig(balance.samplingRel)} output-interval sampling)`} (in ${sig(balance.inW)} W, out ${sig(balance.outW)} W, stored ${sig(balance.storedW)} W)${data.heatBalance.withinTolerance ? '' : ' EXCEEDS the tolerance: do not report as final'}`,
      ...fluxText,
      inputs.unverified ? `unverified inputs: ${inputs.reasons.join('; ')}` : 'no unverified input',
    ];
    return report(doc, `${text.join('; ')}.`, data);
  },
});
