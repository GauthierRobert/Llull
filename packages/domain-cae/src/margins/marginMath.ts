/** Margin-of-safety arithmetic of 05 §5.8 (NASA-STD-5001B form, 14 CFR 25.303 / 25.305(a)): pure helpers. */

import type { AnalysisCase, LoadCategory } from '@core/model/analysis';
import { DEFAULT_FACTORS } from '../shared/defaults';

/** A factor with the source it comes from (AF-31: no anonymous factor). */
interface NamedFactor {
  readonly value: number;
  readonly source: string;
  readonly defaulted: boolean;
}

export interface FactorReport {
  readonly ultimate: NamedFactor;
  readonly yield: NamedFactor;
  readonly extra: readonly {
    readonly name: string;
    readonly value: number;
    readonly justification: string;
    readonly source: string;
    readonly defaulted: false;
  }[];
}

export type CheckKind = 'ultimate' | 'yield';

/**
 * The factors of a case, each named. A value equal to the llull default is `defaulted: true` with the regulation as its source; a value the
 * case states otherwise is `defaulted: false`, source `create_analysis factors`.
 */
export function factorReport(analysis: AnalysisCase): FactorReport {
  const { factors } = analysis;
  return {
    ultimate:
      factors.ultimate === DEFAULT_FACTORS.ultimate
        ? { value: factors.ultimate, source: '14 CFR 25.303', defaulted: true }
        : { value: factors.ultimate, source: 'create_analysis factors.ultimate (stated by the caller)', defaulted: false },
    yield:
      factors.yield === DEFAULT_FACTORS.yield
        ? {
            value: factors.yield,
            source: 'derived from 14 CFR 25.305(a) (limit load, no detrimental permanent deformation)',
            defaulted: true,
          }
        : { value: factors.yield, source: 'create_analysis factors.yield (stated by the caller)', defaulted: false },
    extra: factors.extra.map((factor) => ({ ...factor, source: 'create_analysis factors.extra', defaulted: false })),
  };
}

/** Product of the additional factors. */
const extraProduct = (report: FactorReport): number => report.extra.reduce((product, factor) => product * factor.value, 1);

/**
 * The factor on the applied stress for a check: ultimate on a limit load = FoS_ult x extra, ultimate on an ultimate load = extra only
 * (25.303: no further factor), yield (limit loads only) = FoS_yield x extra.
 */
export function appliedFactor(report: FactorReport, check: CheckKind, category: LoadCategory): number {
  const base = check === 'yield' ? report.yield.value : category === 'limit' ? report.ultimate.value : 1;
  return base * extraProduct(report);
}

/** MS = allowable / (applied x factor) - 1; null when the applied stress is zero (no finite margin). */
export function marginOfSafety(allowable: number, applied: number, factor: number): number | null {
  const demand = applied * factor;
  return demand > 0 ? allowable / demand - 1 : null;
}

export type MarginStatus = 'PASS' | 'MARGINAL' | 'FAIL';

/** FAIL when MS < 0; MARGINAL only when the caller gave a band and 0 <= MS < band; else PASS. */
export function statusOf(ms: number | null, marginalBand: number | undefined): MarginStatus {
  if (ms === null) return 'PASS';
  if (ms < 0) return 'FAIL';
  return marginalBand !== undefined && ms < marginalBand ? 'MARGINAL' : 'PASS';
}
