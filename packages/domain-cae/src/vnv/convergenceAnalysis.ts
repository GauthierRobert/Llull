/** Shared GCI analysis of finest-first samples: findings (codes §7.1), triplets, named defaults. Used by check_convergence and the study commands. */

import {
  gciTriplet,
  richardson,
  requiredSpacing,
  type ConvergenceSample,
  type ConvergenceStatus,
  type TripletReport,
} from '@lib/convergence';
import type { NamedValue } from '@core/model/topology';

interface Finding {
  readonly code: string;
  readonly severity: 'warning' | 'fail';
  readonly message: string;
  readonly remediation: string;
}

const FS_THREE = { value: 1.25, source: 'Roache 1994; Celik et al. 2008' };
const FS_TWO = { value: 3, source: "Roache's two-grid recommendation (as reported in arXiv 2103.14559)" };
const ORDER_TOLERANCE = 0.5;
const ASYMPTOTIC_BAND: readonly [number, number] = [0.95, 1.05];
const RATIO_WARN = 1.3;
const RATIO_REFUSE = 1.1;

export const percent = (fraction: number): string => `${(fraction * 100).toPrecision(3)} %`;

const STATUS_CODES: Partial<Record<ConvergenceStatus, Finding>> = {
  oscillatory: {
    code: 'VNV_OSCILLATORY',
    severity: 'warning',
    message: 'the solution oscillates under refinement (e32/e21 < 0); no extrapolated value is reported',
    remediation: 'refine further or study a smoother quantity',
  },
  divergent: {
    code: 'VNV_DIVERGENT',
    severity: 'warning',
    message: 'differences grow under refinement (|e32/e21| < 1); no extrapolated value is reported',
    remediation: 'check for singularities (point loads, re-entrant corners) or mesh quality',
  },
};

export interface AnalysisOptions {
  readonly safetyFactor?: number | undefined;
  readonly assumedOrder?: number | undefined;
  readonly formalOrder?: number | undefined;
  readonly orderTolerance?: number | undefined;
  readonly gciTarget?: number | undefined;
}

interface ConvergenceAnalysis {
  readonly findings: readonly Finding[];
  readonly triplets: readonly TripletReport[];
  readonly summaryReport: TripletReport;
  readonly safetyFactor: NamedValue;
  readonly formalOrder?: NamedValue;
  readonly defaults: readonly NamedValue[];
  readonly required?: number;
  readonly twoLevel: boolean;
}

export type AnalysisOutcome =
  | { readonly ok: true; readonly analysis: ConvergenceAnalysis }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly path: string };

const refused = (code: string, message: string, path: string): AnalysisOutcome => ({ ok: false, code, message, path });

/**
 * Report of `samples` (sorted finest first, distinct positive h, finite values).
 * @invariant a ratio between 1.1 and 1.3 is a warning; the Fs default is named; non-monotone triplets carry no extrapolation
 * @failure ratio < 1.1 -> VNV_RATIO_TOO_SMALL; two samples without assumedOrder -> VNV_SAMPLES_INVALID; order iteration not converged ->
 *   VNV_ORDER_NOT_CONVERGED
 */
export function analyseSamples(samples: readonly ConvergenceSample[], options: AnalysisOptions): AnalysisOutcome {
  const findings: Finding[] = [];
  for (let k = 1; k < samples.length; k += 1) {
    const fine = samples[k - 1];
    const coarse = samples[k];
    if (fine === undefined || coarse === undefined) continue;
    const ratio = coarse.h / fine.h;
    if (ratio < RATIO_REFUSE)
      return refused(
        'VNV_RATIO_TOO_SMALL',
        `refinement ratio ${ratio.toPrecision(4)} between levels ${k - 1} and ${k} is below 1.1`,
        'samples',
      );
    if (ratio < RATIO_WARN) {
      findings.push({
        code: 'VNV_RATIO_TOO_SMALL',
        severity: 'warning',
        message: `refinement ratio ${ratio.toPrecision(4)} between levels ${k - 1} and ${k} is below the recommended 1.3`,
        remediation: 'refine by a larger ratio (≥ 1.3)',
      });
    }
  }
  const twoLevel = samples.length === 2;
  const fsDefault = twoLevel ? FS_TWO : FS_THREE;
  const safetyFactor: NamedValue =
    options.safetyFactor !== undefined
      ? { value: options.safetyFactor, source: 'caller', defaulted: false }
      : { ...fsDefault, defaulted: true };
  const defaults: NamedValue[] = [];
  if (safetyFactor.defaulted) defaults.push(safetyFactor);

  const triplets: TripletReport[] = [];
  let summaryReport: TripletReport;
  if (twoLevel) {
    const [s1, s2] = samples as [ConvergenceSample, ConvergenceSample];
    const p = options.assumedOrder;
    if (p === undefined) return refused('VNV_SAMPLES_INVALID', 'a two-sample study needs assumedOrder', 'assumedOrder');
    const r21 = s2.h / s1.h;
    summaryReport = {
      levels: [0, 1, 1],
      r21,
      r32: Number.NaN,
      status: 'two_level',
      ratio: Number.NaN,
      p,
      ...richardson(s1.value, s2.value, r21, p, safetyFactor.value),
    };
    findings.push({
      code: 'VNV_TWO_LEVEL_ONLY',
      severity: 'warning',
      message: `two samples only: order assumed (${p}), Fs = ${safetyFactor.value}`,
      remediation: 'add a third level to measure the observed order',
    });
  } else {
    for (let k = 0; k + 2 < samples.length; k += 1) {
      const triplet = gciTriplet(
        [samples[k], samples[k + 1], samples[k + 2]] as [ConvergenceSample, ConvergenceSample, ConvergenceSample],
        safetyFactor.value,
        [k, k + 1, k + 2],
      );
      if ('orderNotConverged' in triplet || (triplet.p !== undefined && !(triplet.p > 0 && Number.isFinite(triplet.p))))
        return refused('VNV_ORDER_NOT_CONVERGED', `the observed-order iteration did not converge for levels ${k}..${k + 2}`, 'samples');
      triplets.push(triplet);
    }
    summaryReport = triplets[0] as TripletReport;
    const statusFinding = STATUS_CODES[summaryReport.status];
    if (statusFinding !== undefined) findings.push(statusFinding);
  }

  const { p, gci21Fine, asymptoticRatio, status } = summaryReport;
  let formalOrder: NamedValue | undefined;
  if (options.formalOrder !== undefined) {
    formalOrder = { value: options.formalOrder, source: 'caller', defaulted: false };
    const tolerance: NamedValue =
      options.orderTolerance !== undefined
        ? { value: options.orderTolerance, source: 'caller', defaulted: false }
        : { value: ORDER_TOLERANCE, source: 'llull choice (no published source)', defaulted: true };
    if (tolerance.defaulted) defaults.push(tolerance);
    if (status === 'monotone' && p !== undefined && Math.abs(p - options.formalOrder) > tolerance.value) {
      findings.push({
        code: 'VNV_ORDER_MISMATCH',
        severity: 'warning',
        message: `observed order ${p.toPrecision(4)} differs from the formal order ${options.formalOrder} by more than ${tolerance.value}`,
        remediation: 'levels are likely not in the asymptotic range: add a finer level',
      });
    }
  }
  if (asymptoticRatio !== undefined && (asymptoticRatio < ASYMPTOTIC_BAND[0] || asymptoticRatio > ASYMPTOTIC_BAND[1])) {
    findings.push({
      code: 'VNV_NOT_ASYMPTOTIC',
      severity: 'warning',
      message: `asymptotic ratio ${asymptoticRatio.toPrecision(4)} is outside [0.95, 1.05] (llull band)`,
      remediation: 'add a finer level',
    });
  }
  if (summaryReport.relativeUndefined === true) {
    findings.push({
      code: 'VNV_RELATIVE_UNDEFINED',
      severity: 'warning',
      message: 'the finest value is 0: the relative GCI is undefined, gciAbs (in the quantity unit) is reported',
      remediation: 'use the absolute GCI or study a non-zero quantity',
    });
  }
  let required: number | undefined;
  const finest = samples[0];
  if (options.gciTarget !== undefined && gci21Fine !== undefined && p !== undefined && finest !== undefined) {
    required = requiredSpacing(options.gciTarget, gci21Fine, p, finest.h);
    if (gci21Fine > options.gciTarget) {
      findings.push({
        code: 'VNV_GCI_ABOVE_TARGET',
        severity: 'fail',
        message: `GCI21 ${percent(gci21Fine)} is above the target ${percent(options.gciTarget)}`,
        remediation: `refine: the target needs h ≈ ${required.toPrecision(4)}`,
      });
    }
  }
  return {
    ok: true,
    analysis: {
      findings,
      triplets,
      summaryReport,
      safetyFactor,
      ...(formalOrder !== undefined ? { formalOrder } : {}),
      defaults,
      ...(required !== undefined ? { required } : {}),
      twoLevel,
    },
  };
}
