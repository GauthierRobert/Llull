/** The element-order (p) branch of a convergence study: two levels (order 2 then order 1, same mesh size) give a difference indicator, never an order or an extrapolation. */

import type { NamedValue } from '@core/model/topology';
import { percent, type Finding } from './analysisShared';
import type { AnalysisOutcome } from './convergenceAnalysis';

const SAFETY: NamedValue = { value: 1, source: 'none: the order difference is an indicator, not a GCI', defaulted: true };

/**
 * The order-difference indicator of an order study: |f2 - f1| and, as a fraction of |f2| (the quadratic value), its relative size.
 * @invariant no observed order, no extrapolated value and no Fs: two orders cannot give them; the difference bounds the LINEAR error from below and is
 *   only an indicator for the quadratic result, so a target is judged as VNV_P_DIFFERENCE_ABOVE_TARGET (never as a GCI)
 * @failure none: a status with findings
 */
export function analyseOrderPair(quadratic: number, linear: number, gciTarget: number | undefined): AnalysisOutcome {
  const absolute = Math.abs(quadratic - linear);
  const relative = quadratic !== 0 ? absolute / Math.abs(quadratic) : undefined;
  const findings: Finding[] = [
    {
      code: 'VNV_P_TWO_LEVEL',
      severity: 'warning',
      message: `two element orders only: the order-1 / order-2 difference ${absolute.toPrecision(3)}${relative === undefined ? '' : ` (${percent(relative)} of the order-2 value)`} is an indicator, no observed order or extrapolated value`,
      remediation: 'add an h study at order 2 to measure the observed order and the GCI',
    },
  ];
  if (gciTarget !== undefined && relative !== undefined && relative > gciTarget)
    findings.push({
      code: 'VNV_P_DIFFERENCE_ABOVE_TARGET',
      severity: 'fail',
      message: `the order-1 / order-2 difference ${percent(relative)} is above the target ${percent(gciTarget)}`,
      remediation: 'refine the mesh (h study at order 2) and re-run',
    });
  return {
    ok: true,
    analysis: {
      findings,
      triplets: [],
      summaryReport: { levels: [0, 1, 1], r21: 2, r32: Number.NaN, status: 'order_pair', ratio: Number.NaN },
      safetyFactor: SAFETY,
      defaults: [],
      twoLevel: false,
      method: 'order-difference',
      orderPair: { quadratic, linear, difference: { absolute, ...(relative !== undefined ? { relative } : {}) } },
    },
  };
}
