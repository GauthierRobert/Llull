/** basis_tolerance_factor (PHY-18): one-sided tolerance factors that explain A-/B-basis values; never an allowable computed from data. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { REVIEW_NOTE } from '../fatigue/items';
import { normalToleranceFactor, nonparametricBasis } from './toleranceFactor';

const DEFAULT_COVERAGE = 0.9;
const DEFAULT_CONFIDENCE = 0.95;
const MAX_N = 100_000;

/**
 * @affects nothing; read-only, data { method, n, coverage, confidence, k | rank, minimumN, note, reviewRequired: true }
 * @invariant normal: k = t'_confidence(n - 1, z_coverage sqrt(n)) / sqrt(n) (exact non-central t); nonparametric: largest rank r with P(Bin(n, 1 - coverage) >= r) >= confidence
 * @failure n < 2 or above 100000, coverage / confidence outside (0, 1) -> unchanged doc, summary names the bad value
 */
export const basisToleranceFactor = defineCommand({
  name: 'basis_tolerance_factor',
  annotations: { readOnly: true },
  description:
    'One-sided tolerance factor behind a design basis value (B-basis: 90 % of the population above the value with 95 % confidence; A-basis: 99 % / 95 %). ' +
    'method "normal" (default): for n normally distributed test values the basis value is mean - k * sd, k = non-central t quantile / sqrt(n) (exact; k(10) = 2.355 for B, 3.981 for A; k tends to 1.2816 / 2.3263 as n grows). ' +
    'method "nonparametric": distribution-free, the basis value is the `rank`-th lowest of the n values (rank 0 = n too small; minimumN = 299 for A, 29 for B). ' +
    'It only explains k(n): llull never computes an allowable from data, and a basis value is not turned into a distribution mean (supply a cited distribution to define_random_variable). ' +
    `coverage default 0.90 (B-basis), pass 0.99 for A-basis; confidence default 0.95. ${REVIEW_NOTE}`,
  params: z.object({
    n: z.number().int().min(2).max(MAX_N).describe('Number of test values (2 to 100000).'),
    coverage: z
      .number()
      .gt(0)
      .lt(1)
      .optional()
      .describe(`Population fraction above the value: 0.90 (B-basis, default) or 0.99 (A-basis), or any number in (0, 1).`),
    confidence: z.number().gt(0).lt(1).optional().describe(`Confidence level in (0, 1) (default ${DEFAULT_CONFIDENCE}).`),
    method: z
      .enum(['normal', 'nonparametric'])
      .optional()
      .describe('"normal" (default, exact non-central t) or "nonparametric" (order statistic).'),
  }),
  run: (doc, params): CommandResult => {
    const coverage = params.coverage ?? DEFAULT_COVERAGE;
    const confidence = params.confidence ?? DEFAULT_CONFIDENCE;
    const method = params.method ?? 'normal';
    const common = { n: params.n, coverage, confidence, reviewRequired: true };
    if (method === 'nonparametric') {
      const basis = nonparametricBasis(params.n, coverage, confidence);
      const note =
        basis.rank === 0
          ? `n = ${params.n} is below the minimum ${basis.minimumN}: no distribution-free basis value`
          : `the basis value is the ${basis.rank}-th lowest of the ${params.n} values (minimum n ${basis.minimumN})`;
      return report(doc, `basis_tolerance_factor (nonparametric, ${coverage}/${confidence}, n = ${params.n}): ${note}. ${REVIEW_NOTE}`, {
        ...common,
        method: 'nonparametric order statistic',
        ...basis,
        note,
      });
    }
    const k = normalToleranceFactor(params.n, coverage, confidence);
    const note = 'basis value = mean - k * sd of the test values (normal population); an allowable is never computed here';
    return report(
      doc,
      `basis_tolerance_factor (normal, ${coverage}/${confidence}, n = ${params.n}): k = ${k.toPrecision(7)}. ${REVIEW_NOTE}`,
      { ...common, method: 'non-central t', k, note },
    );
  },
});
