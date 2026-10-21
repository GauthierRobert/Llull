/** View 'thermal' of analysis_report: temperatures, heat flows and heat balance of a solved heat_* analysis, as data (PHY-03 FR-THM-11, FR-THM-12, AF-10). */

import { significantNumber } from '@lib/compactNumber';
import { report } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { evaluateProbes } from '../results/probes';
import { buildDeckContext } from '../decks/context';
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
export function thermalResultsReport(
  doc: CadDocument,
  { analysisId, timeS, probes }: { analysisId: string; timeS?: number | undefined; probes?: readonly string[] | undefined },
  ctx?: ExecutionContext,
): CommandResult {
  const found = thermalCaseOf(doc, analysisId);
  if (isProblem(found)) return refuseThermal(doc, 'analysis_report', found.code, found.message, found.ids, found.paths);
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
    return report(doc, `analysis_report: '${analysisId}' — ${state} (${why}).`, { ...header, message: why });
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
    `analysis_report: '${analysisId}' ${state}`,
    `max ${sig(summary.maxT.value)} ${unit} at [${summary.maxT.at.map(sig).join(', ')}] ${steady ? 'steady state' : `t=${sig(summary.maxT.timeS)} s`}`,
    `min ${sig(summary.minT.value)} ${unit}`,
    `heat balance residual ${sig(balance.residualRel)}${balance.samplingRel === undefined ? '' : ` (± ${sig(balance.samplingRel)} output-interval sampling)`} (in ${sig(balance.inW)} W, out ${sig(balance.outW)} W, stored ${sig(balance.storedW)} W)${data.heatBalance.withinTolerance ? '' : ' EXCEEDS the tolerance: do not report as final'}`,
    ...fluxText,
    inputs.unverified ? `unverified inputs: ${inputs.reasons.join('; ')}` : 'no unverified input',
  ];
  return report(doc, `${text.join('; ')}.`, data);
}
