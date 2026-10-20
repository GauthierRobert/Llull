/** analyze_stackup: 1D / non-linear tolerance stack-up query (GDT FR-GDT-16/17/34/35, TR-GDT-11). */

import { programFunction } from '../../lib/expressionProgram';
import { sampleStackup } from '../../lib/stackupSampling';
import { report } from '../noop';
import { defineCommand } from '../schema';
import type { CommandResult } from '../types';
import { refuseGdt } from './codes';
import { isStackupRefusal, resolveStackup, sampledContributors, stackupData, stackupParams, STACKUP_TS_SAMPLES_CAP } from './stackupModel';

const fmt = (value: unknown): string => (typeof value === 'number' ? String(Number(value.toPrecision(6))) : 'n/a');

/**
 * @affects none (query); data = { yNominal, yMean, worstCase, worstCaseExactCorners, rss, sigma, pBelowLowerLimit, pAboveUpperLimit, pMethod, contributions, monteCarlo?, sigmaPerHalfTolerance, provenance, unverified?, warnings, reviewRequired }
 * @invariant Monte Carlo is a pure function of (params): Philox4x32-10 counter streams, fixed-chunk reductions (bit-identical to llull-compute stats)
 * @failure bad names / values -> GDT_STACKUP_CONTRIBUTOR_INVALID; lower > upper -> GDT_LIMITS_INVERTED; expression and sensitivities both / neither -> GDT_STACKUP_SENSITIVITY_CONFLICT; parse error -> GDT_STACKUP_EXPRESSION; samples outside 1000..2e6 -> GDT_STACKUP_SAMPLES_CAP; non-finite sample -> GDT_STACKUP_NON_FINITE
 */
export const analyzeStackup = defineCommand({
  name: 'analyze_stackup',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only tolerance stack-up of named contributors (each nominal with signed upper / lower limits, normal or uniform): ' +
    'y = expression(contributors) or a linear stack y = Σ sensitivity_i x_i. Reports the nominal and mean of y, worst case (linearised) ' +
    'and exact corners, RSS, σ_y, P(y < lowerSpecLimit) / P(y > upperSpecLimit) (exact normal CDF, or exact uniform-sum CDF), per-contributor ' +
    '% of WC and RSS, and with methods ["monteCarlo"] a seeded deterministic Monte Carlo (Philox4x32-10, up to 2e6 samples; above, ' +
    'use the native stackup_monte_carlo tool which draws the same samples). Defaults (σ = half tolerance / 3, seed, samples) are named in ' +
    'the result. Contributors with verified: false are listed in data.unverified. A qualified engineer must review the result.',
  params: stackupParams,
  run: (doc, params): CommandResult => {
    const model = resolveStackup(params, STACKUP_TS_SAMPLES_CAP, doc);
    if (isStackupRefusal(model)) return refuseGdt(doc, 'analyze_stackup', model.code, model.message, [], model.paths);
    let monteCarlo = null;
    if (model.methods.has('monteCarlo')) {
      const stats = sampleStackup({
        contributors: sampledContributors(model),
        evaluate: programFunction(model.program),
        samples: model.samples,
        seed: model.seed,
        ...(params.lowerSpecLimit === undefined ? {} : { lowerSpecLimit: params.lowerSpecLimit }),
        ...(params.upperSpecLimit === undefined ? {} : { upperSpecLimit: params.upperSpecLimit }),
      });
      if (stats.nonFinite > 0)
        return refuseGdt(
          doc,
          'analyze_stackup',
          'GDT_STACKUP_NON_FINITE',
          `${stats.nonFinite} of ${stats.samples} samples are not finite`,
          [],
          ['expression'],
        );
      monteCarlo = { stats, engine: 'ts' as const };
    }
    const data = stackupData(model, doc.units, monteCarlo);
    const mc = data['monteCarlo'] as Record<string, unknown> | undefined;
    const wc = data['worstCase'] as { min: number; max: number } | undefined;
    const rss = data['rss'] as { halfTolerance: number } | undefined;
    return report(
      doc,
      `analyze_stackup${params.name === undefined ? '' : ` "${params.name}"`}: y mean ${fmt(data['yMean'])} ${doc.units}` +
        (wc === undefined ? '' : `, WC [${fmt(wc.min)}, ${fmt(wc.max)}]`) +
        (rss === undefined ? '' : `, RSS ±${fmt(rss.halfTolerance)}`) +
        `, σ ${fmt(data['sigma'])}` +
        (data['pBelowLowerLimit'] === undefined ? '' : `, P(y<L) ${fmt(data['pBelowLowerLimit'])}`) +
        (data['pAboveUpperLimit'] === undefined ? '' : `, P(y>U) ${fmt(data['pAboveUpperLimit'])}`) +
        (mc === undefined ? '' : `; Monte Carlo ${String(mc['samples'])} samples: mean ${fmt(mc['mean'])}, std ${fmt(mc['std'])}`) +
        '. Not approved: a qualified engineer must review.',
      data,
    );
  },
});
