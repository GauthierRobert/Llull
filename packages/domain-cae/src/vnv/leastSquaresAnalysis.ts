/** The least-squares branch of the convergence analysis (PHY-00 FR-VNV-19): 4 or more samples fitted with f = f0 + alpha h^p (Eca & Hoekstra model). */

import {
  classify,
  leastSquaresOrder,
  leastSquaresUncertainty,
  type ConvergenceSample,
  type ConvergenceStatus,
  type LeastSquaresFit,
  type TripletReport,
} from '@lib/convergence';
import { LSQ_METHOD, type Finding, type LeastSquaresSummary } from './analysisShared';

export interface FitOutcome {
  readonly status: ConvergenceStatus;
  readonly summaryReport: TripletReport;
  readonly lsq?: LeastSquaresSummary;
  readonly findings: readonly Finding[];
}

/** Named llull choice: the fit is "poor" when its standard deviation exceeds the correction it makes to the finest value. */
const POOR_FIT_NOTE = 'standard deviation of the fit above the finest-level correction |f1 - f0| (llull band)';

const OSCILLATORY: Finding = {
  code: 'VNV_OSCILLATORY',
  severity: 'warning',
  message: 'the samples are not monotone under refinement (consecutive differences change sign or vanish); no fit is reported',
  remediation: 'refine further or study a smoother quantity',
};

const divergent = (why: string): Finding => ({
  code: 'VNV_DIVERGENT',
  severity: 'warning',
  message: `${why}; no extrapolated value is reported`,
  remediation: 'check for singularities (point loads, re-entrant corners) or mesh quality',
});

/**
 * Status, fit and findings of `samples` (4 or more, finest first) from the least-squares model; `triplets` are the Celik triplets of the same data.
 * @invariant a non-monotone, divergent or unfittable set carries no p / extrapolation; the fit uses all levels with equal weights
 * @failure none: every outcome is a status with findings (the caller keeps the triplets for the report)
 */
export function fitOutcome(samples: readonly ConvergenceSample[], triplets: readonly TripletReport[], safetyFactor: number): FitOutcome {
  const [s1, s2, s3] = samples;
  const base = triplets[0] ?? ({ levels: [0, 1, 2], r21: Number.NaN, r32: Number.NaN, status: 'monotone', ratio: Number.NaN } as const);
  const withStatus = (status: ConvergenceStatus): TripletReport => ({ ...base, status });
  if (s1 === undefined || s2 === undefined || s3 === undefined) return { status: 'monotone', summaryReport: base, findings: [] };
  const statuses = samples
    .slice(0, -2)
    .map(
      (sample, k) =>
        classify(sample.value, (samples[k + 1] as ConvergenceSample).value, (samples[k + 2] as ConvergenceSample).value).status,
    );
  if (statuses.every((status) => status === 'converged_exactly'))
    return { status: 'converged_exactly', summaryReport: withStatus('converged_exactly'), findings: [] };
  if (statuses.some((status) => status === 'oscillatory' || status === 'converged_exactly'))
    return { status: 'oscillatory', summaryReport: withStatus('oscillatory'), findings: [OSCILLATORY] };
  if (statuses.every((status) => status === 'divergent'))
    return {
      status: 'divergent',
      summaryReport: withStatus('divergent'),
      findings: [divergent('differences grow under refinement (every triplet has |e32/e21| < 1)')],
    };
  const fit = leastSquaresOrder(samples);
  if (!fit.converged)
    return {
      status: 'no_fit',
      summaryReport: { levels: base.levels, r21: base.r21, r32: base.r32, ratio: base.ratio, status: 'no_fit' },
      findings: [
        {
          code: 'VNV_LSQ_NO_FIT',
          severity: 'warning',
          message: `no observed order in [0.05, 8] fits the samples (${fit.reason}); no extrapolated value is reported`,
          remediation: 'observed order outside [0.05, 8]: add levels, or use 3 levels (Celik triplet)',
        },
      ],
    };
  return fitted(samples, base, fit, safetyFactor);
}

function fitted(samples: readonly ConvergenceSample[], base: TripletReport, fit: LeastSquaresFit, safetyFactor: number): FitOutcome {
  const finest = samples[0] as ConvergenceSample;
  const uncertainty = leastSquaresUncertainty(fit, finest, safetyFactor);
  const lsq: LeastSquaresSummary = {
    method: LSQ_METHOD,
    p: fit.p,
    f0: fit.f0,
    alpha: fit.alpha,
    ...(fit.standardError !== undefined ? { standardError: fit.standardError } : {}),
    residual: { rss: fit.rss, rms: fit.residualRms, standardDeviation: fit.standardDeviation, degreesOfFreedom: fit.degreesOfFreedom },
    uncertainty,
  };
  const summaryReport: TripletReport = {
    levels: base.levels,
    r21: base.r21,
    r32: base.r32,
    status: 'monotone',
    ratio: base.ratio,
    p: fit.p,
    extrapolated: fit.f0,
    ...(uncertainty.relative === undefined ? { gciAbs: uncertainty.absolute, relativeUndefined: true as const } : {}),
  };
  const findings: Finding[] = [];
  if (fit.standardDeviation > Math.abs(finest.value - fit.f0))
    findings.push({
      code: 'VNV_LSQ_POOR_FIT',
      severity: 'warning',
      message: `poor least-squares fit: ${POOR_FIT_NOTE} (${fit.standardDeviation.toPrecision(3)} > ${Math.abs(finest.value - fit.f0).toPrecision(3)})`,
      remediation: 'add finer levels or study a smoother quantity',
    });
  if (fit.degreesOfFreedom < 2)
    findings.push({
      code: 'VNV_LSQ_FEW_DOF',
      severity: 'warning',
      message: `the fit has ${fit.degreesOfFreedom} degree of freedom (4 levels, 3 fitted parameters): its standard errors and uncertainty are weak`,
      remediation: 'add a fifth level before relying on the fit',
    });
  return { status: 'monotone', summaryReport, lsq, findings };
}
