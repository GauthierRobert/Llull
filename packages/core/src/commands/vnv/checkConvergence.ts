/** check_convergence: grid-convergence study of a scalar result from measured samples (PHY-00, Celik et al. 2008 / Roache GCI). */

import {
  gciTriplet,
  representativeSpacing,
  requiredSpacing,
  richardson,
  type ConvergenceSample,
  type ConvergenceStatus,
  type TripletReport,
} from '../../lib/convergence';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { codedRejection, report } from '../noop';

export interface NamedValue {
  readonly value: number;
  readonly source: string;
  readonly defaulted: boolean;
}

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

const FORMULAS = [
  'R = e32/e21, e21 = f2 - f1, e32 = f3 - f2 (finest first)',
  'p = |ln|R| + q(p)| / ln r21, q(p) = ln((r21^p - s)/(r32^p - s))',
  'f_ext = (r21^p f1 - f2)/(r21^p - 1)',
  'GCI21_fine = Fs |(f1 - f2)/f1| / (r21^p - 1)',
  'AR = r21^p GCI21_fine / GCI32_fine',
  'h* = h1 / (GCI21 / GCI*)^(1/p)',
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

const percent = (fraction: number): string => `${(fraction * 100).toPrecision(3)} %`;

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
    gciTarget: z.number().positive().optional().describe('Target GCI21 as a fraction (0.01 = 1 %): adds requiredSpacing and a check.'),
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
    const findings: Finding[] = [];
    for (let k = 1; k < samples.length; k += 1) {
      const ratio = (samples[k]?.h ?? 0) / (samples[k - 1]?.h ?? 1);
      if (ratio < RATIO_REFUSE)
        return fail(
          doc,
          `refinement ratio ${ratio.toPrecision(4)} between levels ${k - 1} and ${k} is below 1.1`,
          'samples',
          'VNV_RATIO_TOO_SMALL',
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
    if (twoLevel && params.assumedOrder === undefined) return fail(doc, 'a two-sample study needs assumedOrder', 'assumedOrder');
    const fsDefault = twoLevel ? FS_TWO : FS_THREE;
    const safetyFactor: NamedValue =
      params.safetyFactor !== undefined
        ? { value: params.safetyFactor, source: 'caller', defaulted: false }
        : { ...fsDefault, defaulted: true };
    const defaults: NamedValue[] = [];
    if (safetyFactor.defaulted) defaults.push(safetyFactor);

    const triplets: TripletReport[] = [];
    let summaryReport: TripletReport;
    if (twoLevel) {
      const [s1, s2] = samples as [ConvergenceSample, ConvergenceSample];
      const p = params.assumedOrder ?? 0;
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
          return fail(doc, `the observed-order iteration did not converge for levels ${k}..${k + 2}`, 'samples', 'VNV_ORDER_NOT_CONVERGED');
        triplets.push(triplet);
      }
      summaryReport = triplets[0] as TripletReport;
      const statusFinding = STATUS_CODES[summaryReport.status];
      if (statusFinding !== undefined) findings.push(statusFinding);
    }

    const { p, gci21Fine, asymptoticRatio, status } = summaryReport;
    let formalOrder: NamedValue | undefined;
    if (params.formalOrder !== undefined) {
      formalOrder = { value: params.formalOrder, source: 'caller', defaulted: false };
      const tolerance: NamedValue =
        params.orderTolerance !== undefined
          ? { value: params.orderTolerance, source: 'caller', defaulted: false }
          : { value: ORDER_TOLERANCE, source: 'llull choice (no published source)', defaulted: true };
      if (tolerance.defaulted) defaults.push(tolerance);
      if (status === 'monotone' && p !== undefined && Math.abs(p - params.formalOrder) > tolerance.value) {
        findings.push({
          code: 'VNV_ORDER_MISMATCH',
          severity: 'warning',
          message: `observed order ${p.toPrecision(4)} differs from the formal order ${params.formalOrder} by more than ${tolerance.value}`,
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
    if (params.gciTarget !== undefined && gci21Fine !== undefined && p !== undefined) {
      required = requiredSpacing(params.gciTarget, gci21Fine, p, samples[0]?.h ?? 0);
      if (gci21Fine > params.gciTarget) {
        findings.push({
          code: 'VNV_GCI_ABOVE_TARGET',
          severity: 'fail',
          message: `GCI21 ${percent(gci21Fine)} is above the target ${percent(params.gciTarget)}`,
          remediation: `refine: the target needs h ≈ ${required.toPrecision(4)}`,
        });
      }
    }

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
      triplets,
      safetyFactor,
      ...(formalOrder !== undefined ? { formalOrder } : {}),
      defaults,
      fractionUnit: 'fraction (ea21, eext21, gci21, gci32Fine; 0.01 = 1 %)',
      provenance: { procedure: 'celik2008-gci', formulas: FORMULAS, samples, safetyFactor: safetyFactor.value },
    };
    const head = `check_convergence ${params.quantity}: ${status} over ${samples.length} levels`;
    const summary =
      extrapolates && p !== undefined && gci21Fine !== undefined
        ? `${head}, observed order ${p.toPrecision(4)}, extrapolated ${(summaryReport.extrapolated ?? 0).toPrecision(6)} ${params.unit}; ` +
          `estimated discretisation error (GCI, Fs ${safetyFactor.value}) ${percent(gci21Fine)} of the finest value.`
        : `${head}; no extrapolated value${findings.length > 0 ? ` (${findings.map((f) => f.code).join(', ')})` : ''}.`;
    return report(doc, summary, data);
  },
});
