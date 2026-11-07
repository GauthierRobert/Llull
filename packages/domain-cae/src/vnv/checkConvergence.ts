/** check_convergence: grid-convergence study of a scalar result from measured samples (PHY-00, Celik et al. 2008 / Roache GCI; least-squares fit over 4+ samples). */

import { representativeSpacing, type ConvergenceSample } from '@lib/convergence';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { codedRejection, report } from '@core/commands/noop';
import { percent } from './analysisShared';
import { analyseSamples } from './convergenceAnalysis';

const FORMULAS = [
  'R = e32/e21, e21 = f2 - f1, e32 = f3 - f2 (finest first)',
  'p = |ln|R| + q(p)| / ln r21, q(p) = ln((r21^p - s)/(r32^p - s))',
  'f_ext = (r21^p f1 - f2)/(r21^p - 1)',
  'GCI21_fine = Fs |(f1 - f2)/f1| / (r21^p - 1)',
  'AR = r21^p GCI21_fine / GCI32_fine',
  'h* = h1 / (GCI21 / GCI*)^(1/p)',
];

const LSQ_FORMULAS = [
  'f(h) = f0 + a h^p fitted to every sample (weights 1): for each p, (f0, a) from the straight-line fit of f against h^p; p minimises the residual over [0.05, 8], then Gauss-Newton on (f0, a, p)',
  'standard error: sqrt(diag(s^2 (J^T J)^-1)), s^2 = sum r^2 / (n - 3)',
  'U = Fs |f1 - f0| + s, s = sqrt(sum r^2 / (n - 3)) (after Eca & Hoekstra 2014)',
];

const fail = (doc: Parameters<typeof report>[0], why: string, path: string, code = 'VNV_SAMPLES_INVALID'): CommandResult =>
  codedRejection(
    doc,
    'check_convergence',
    code,
    why,
    'Supply ≥ 3 distinct positive spacings (refinement ratio ≥ 1.3) with finite values.',
    [],
    [path],
  );

/**
 * @affects nothing — read-only; data { status, codes[], findings[], p?, extrapolated?, gci21, triplets[], safetyFactor, provenance, unit }
 * @invariant non-monotone samples never carry `extrapolated`; Fs is a named default; samples are sorted finest first
 * @failure < 2 samples, h ≤ 0 or missing, duplicate h, 2 samples without assumedOrder -> VNV_SAMPLES_INVALID; consecutive ratio < 1.1 ->
 *   VNV_RATIO_TOO_SMALL; order iteration not converged -> VNV_ORDER_NOT_CONVERGED (all rejections, document unchanged)
 */
export const checkConvergence = defineCommand({
  name: 'check_convergence',
  annotations: { readOnly: true },
  description:
    'Grid-convergence check of one scalar result (Celik et al. 2008 procedure, Roache GCI): from 2–12 samples of the same quantity at ' +
    'different mesh spacings h (or element counts with the domain measure), returns the observed order p, the Richardson-extrapolated ' +
    'value (in `unit`), the Grid Convergence Index of the finest sample (GCI21 fine/coarse, a FRACTION of the value: 0.01 = 1 %), GCI32, ' +
    'the asymptotic ratio (≈ 1 in the asymptotic range) and, with gciTarget, the spacing needed to reach it. Classifies first: ' +
    'oscillatory or divergent samples return a code (VNV_OSCILLATORY / VNV_DIVERGENT) and NO extrapolated value. Safety factor 1.25 ' +
    '(≥ 3 levels) or 3 (two levels, needs assumedOrder) as named defaults. Warnings: VNV_ORDER_MISMATCH (|p − formalOrder| > 0.5), ' +
    'VNV_NOT_ASYMPTOTIC, VNV_RATIO_TOO_SMALL, VNV_TWO_LEVEL_ONLY. Read-only; next: refine further, or report the GCI as an estimated ' +
    'discretisation error.',
  params: z.object({
    quantity: z.string().describe('What was measured, e.g. "tip u_y" or "max von Mises at the lug".'),
    unit: z.string().describe("Unit of every sample value, e.g. 'mm', 'MPa', '1' (dimensionless)."),
    samples: z
      .array(
        z.object({
          h: z.number().optional().describe('Representative mesh spacing (any consistent length unit); > 0, distinct per sample.'),
          elements: z
            .number()
            .int()
            .optional()
            .describe('Element count; with measure + dimension gives h = (measure/elements)^(1/dimension).'),
          value: z.union([z.number(), z.nan()]).describe('The quantity at this spacing, in `unit` (finite).'),
        }),
      )
      .min(1)
      .max(12)
      .describe('Samples in any order (sorted finest first). At least 3 for a full study; 2 only with assumedOrder.'),
    measure: z.number().positive().optional().describe('Domain length, area or volume (unit^dimension) when samples give elements.'),
    dimension: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .optional()
      .describe('Spatial dimension 1, 2 or 3 for elements -> h.'),
    formalOrder: z.number().positive().optional().describe('Formal order of the method (e.g. 2 for linear tets in displacement).'),
    orderTolerance: z.number().positive().optional().describe('Allowed |p − formalOrder| before VNV_ORDER_MISMATCH. Default 0.5 (named).'),
    assumedOrder: z.number().positive().optional().describe('Order assumed for a two-sample study (required with exactly 2 samples).'),
    safetyFactor: z.number().positive().optional().describe('GCI safety factor Fs. Default 1.25 (≥ 3 samples) or 3 (2 samples).'),
    gciTarget: z
      .number()
      .positive()
      .optional()
      .describe('Target GCI21 (or least-squares uncertainty) as a fraction (0.01 = 1 %): adds requiredSpacing and a check.'),
    method: z
      .enum(['gci', 'least_squares'])
      .optional()
      .describe(
        "'gci' (default): Celik triplet of the finest three samples, the others as extra triplets. 'least_squares': fit f = f0 + a h^p to ALL samples (needs 4 or more; Eca & Hoekstra model): reports p, f0, standard errors, the fit residual and an uncertainty = Fs |f1 - f0| + fit standard deviation. Prefer it for noisy unstructured-mesh studies.",
      ),
  }),
  run: (doc, params): CommandResult => {
    const samples: ConvergenceSample[] = [];
    for (const [index, raw] of params.samples.entries()) {
      let h = raw.h;
      if (h === undefined && raw.elements !== undefined && params.measure !== undefined && params.dimension !== undefined) {
        if (raw.elements <= 0) return fail(doc, `samples[${index}].elements must be > 0`, `samples[${index}].elements`);
        h = representativeSpacing(params.measure, raw.elements, params.dimension);
      }
      if (h === undefined) return fail(doc, `samples[${index}] needs h, or elements with measure and dimension`, `samples[${index}]`);
      if (!(h > 0) || !Number.isFinite(h)) return fail(doc, `samples[${index}].h must be a finite spacing > 0`, `samples[${index}].h`);
      if (!Number.isFinite(raw.value)) return fail(doc, `samples[${index}].value must be finite`, `samples[${index}].value`);
      if (samples.some((other) => other.h === h)) return fail(doc, `samples[${index}] repeats h = ${h}`, `samples[${index}].h`);
      samples.push({ h, value: raw.value });
    }
    if (samples.length < 2) return fail(doc, 'at least 2 samples are needed (3 for a full study)', 'samples');
    samples.sort((a, b) => a.h - b.h);
    const outcome = analyseSamples(samples, params);
    if (!outcome.ok) return fail(doc, outcome.message, outcome.path, outcome.code);
    const { findings, triplets, summaryReport, safetyFactor, formalOrder, defaults, required, lsq, method } = outcome.analysis;
    const { p, gci21Fine, asymptoticRatio, status } = summaryReport;

    const extrapolates = status === 'monotone' || status === 'two_level';
    const data = {
      quantity: params.quantity,
      unit: params.unit,
      status,
      codes: findings.map((f) => f.code),
      findings,
      ...(extrapolates && p !== undefined ? { p } : {}),
      ...(extrapolates && summaryReport.extrapolated !== undefined ? { extrapolated: summaryReport.extrapolated } : {}),
      ...(extrapolates && summaryReport.ea21 !== undefined ? { ea21: summaryReport.ea21 } : {}),
      ...(extrapolates && summaryReport.eext21 !== undefined ? { eext21: summaryReport.eext21 } : {}),
      ...(extrapolates && gci21Fine !== undefined ? { gci21: { fine: gci21Fine, coarse: summaryReport.gci21Coarse ?? gci21Fine } } : {}),
      ...(extrapolates && summaryReport.gciAbs !== undefined ? { gciAbs: summaryReport.gciAbs } : {}),
      ...(summaryReport.gci32Fine !== undefined ? { gci32Fine: summaryReport.gci32Fine } : {}),
      ...(asymptoticRatio !== undefined ? { asymptoticRatio } : {}),
      ...(required !== undefined ? { requiredSpacing: required } : {}),
      ...(lsq !== undefined ? { lsq } : {}),
      triplets,
      safetyFactor,
      ...(formalOrder !== undefined ? { formalOrder } : {}),
      defaults,
      fractionUnit: 'fraction (ea21, eext21, gci21, gci32Fine; 0.01 = 1 %)',
      provenance: {
        procedure: method,
        formulas: method === 'celik2008-gci' ? FORMULAS : LSQ_FORMULAS,
        samples,
        safetyFactor: safetyFactor.value,
      },
    };
    const head = `check_convergence ${params.quantity}: ${status} over ${samples.length} levels`;
    const summary =
      lsq !== undefined
        ? `${head}, least-squares fit (${lsq.method}): observed order ${lsq.p.toPrecision(4)} (standard error ${lsq.standardError?.p.toPrecision(2) ?? 'n/a'}), extrapolated ${lsq.f0.toPrecision(6)} ${params.unit}, fit standard deviation ${lsq.residual.standardDeviation.toPrecision(3)} ${params.unit}; estimated uncertainty ${lsq.uncertainty.relative === undefined ? `${lsq.uncertainty.absolute.toPrecision(3)} ${params.unit}` : `${percent(lsq.uncertainty.relative)} of the finest value`}.`
        : extrapolates && p !== undefined && gci21Fine !== undefined && summaryReport.extrapolated !== undefined
          ? `${head}, observed order ${p.toPrecision(4)}, extrapolated ${summaryReport.extrapolated.toPrecision(6)} ${params.unit}; ` +
            `estimated discretisation error (GCI, Fs ${safetyFactor.value}) ${percent(gci21Fine)} of the finest value.`
          : `${head}; no extrapolated value${findings.length > 0 ? ` (${findings.map((f) => f.code).join(', ')})` : ''}.`;
    return report(doc, summary, data);
  },
});
