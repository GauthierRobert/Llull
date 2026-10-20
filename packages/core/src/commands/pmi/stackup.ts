import type { PmiItem } from '../../model/pmi';
import { toleranceBasis } from '../../geometry/pmiText';
import {
  type StackContributor,
  type StackDistribution,
  contributions,
  exactCorners,
  exactProbabilities,
  halfOf,
  meanOf,
  monteCarlo,
  probabilityAcceptance,
  rssHalf,
  stackSigma,
  worstCaseHalf,
} from '../../lib/stackup';
import { compileStackExpression, parseStackExpression, stackGradient } from '../../lib/stackExpression';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { findPmi, refuse } from './pmiOps';

const MAX_SAMPLES = 2_000_000;
const DEFAULT_SAMPLES = 100_000;
const DEFAULT_SEED = 1;
const DEFAULT_SIGMA_PER_HALF_TOLERANCE = 3;
const IDENTIFIER = /^[A-Za-z_]\w*$/;

const contributorSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Unique contributor name. With an expression it must be a plain identifier (letters, digits, underscore).'),
  nominal: z
    .number()
    .optional()
    .describe(
      'Nominal value, document length units (degrees for an angle). Required unless pmiId is given (then measured from the PMI item).',
    ),
  upper: z.number().optional().describe('Upper deviation from nominal (>= lower), same unit. Required unless pmiId is given.'),
  lower: z.number().optional().describe('Lower deviation from nominal (<= upper), same unit. Required unless pmiId is given.'),
  sensitivity: z
    .number()
    .optional()
    .describe(
      'Coefficient of this value in the result for a linear stack (+1 grows it, -1 shrinks it, any real). Give EITHER an expression OR sensitivities; with neither, +1.',
    ),
  distribution: z
    .enum(['normal', 'uniform'])
    .optional()
    .describe('normal (default): sigma = half tolerance / sigmaPerHalfTolerance. uniform: half tolerance / sqrt(3).'),
  unit: z.enum(['length', 'deg']).optional().describe('Informational: "deg" for an angle contributor. Default length (document units).'),
  pmiId: z
    .string()
    .optional()
    .describe(
      'Id of a size or location dimension whose measured nominal and tolerance feed this contributor; the stack updates when the PMI changes.',
    ),
  verified: z
    .boolean()
    .optional()
    .describe(
      'true when the limits are confirmed against their source. Default true for a pmiId-linked contributor, false for typed values.',
    ),
});

interface Resolved {
  readonly contributor: StackContributor;
  readonly verified: boolean;
  readonly source: string;
  readonly unit: 'length' | 'deg';
}

/**
 * @affects nothing — read-only
 * @invariant deterministic for (seed, samples, inputs); sensitivities from an expression are exact (dual numbers); typed contributors are unverified unless verified: true
 * @failure bad expression, both expression and sensitivities, samples > 2e6, unknown / untoleranced pmiId, lower > upper, duplicate names -> coded refusal
 */
export const analyzeStackup = defineCommand({
  name: 'analyze_stackup',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Tolerance stack-up of a result built from named contributors, each { name, nominal, upper, lower } (deviations from the nominal, document ' +
    'length units, degrees for angles) or linked to a PMI size / location dimension by pmiId (nominal measured from the B-rep, limits from ' +
    'its tolerance: the stack follows the PMI). Give an `expression` of the names (+ - * / ( ) and sin cos tan asin acos atan sqrt abs exp ln ' +
    'pow hypot pi; sensitivities are then exact derivatives at the contributor means, no finite differences) OR a per-contributor ' +
    'sensitivity for a linear stack. Returns data { unit, nominal, mean, worstCase{min,max,halfTolerance} (linearised arithmetic), ' +
    'worstCaseExactCorners (non-linear check, up to 16 contributors), rss{halfTolerance,min,max}, sigma, pBelow, pAbove (exact for all-normal ' +
    'or all-uniform linear stacks) against lowerSpecLimit / upperSpecLimit, contributions[{name,wcPercent,rssPercent}], monteCarlo{seed,samples,' +
    'mean,std,min,max,pBelow,pAbove,acceptance} when methods has monteCarlo (seeded, deterministic, <= 2000000 samples), ' +
    'sigmaPerHalfTolerance{value,source,defaulted}, provenance, unverified{contributors}, reviewRequired }. Typed limits are unverified ' +
    'until verified: true; every result needs review by a qualified engineer. Refusals: GDT_STACKUP_EXPRESSION, GDT_STACKUP_SENSITIVITY_CONFLICT, ' +
    'GDT_STACKUP_SAMPLES_CAP, GDT_STACKUP_CONTRIBUTOR_UNTOLERANCED, GDT_PMI_UNKNOWN, GDT_STACKUP_INVALID.',
  params: z.object({
    name: z.string().optional().describe('Label of the stack-up, echoed in the result.'),
    contributors: z.array(contributorSchema).min(1).describe('The contributors, at least one.'),
    expression: z
      .string()
      .optional()
      .describe(
        'Result as an expression of the contributor names, e.g. "H - (A + B + C + D)". Omit for a linear stack with sensitivities.',
      ),
    methods: z
      .array(z.enum(['worstCase', 'rss', 'monteCarlo']))
      .optional()
      .describe('Methods to report. Default ["worstCase","rss"]; closed forms are always computed, monteCarlo only when listed.'),
    lowerSpecLimit: z.number().optional().describe('Smallest acceptable result, document units; gives pBelow.'),
    upperSpecLimit: z.number().optional().describe('Largest acceptable result, document units; gives pAbove.'),
    samples: z.number().int().min(1).optional().describe(`Monte Carlo samples, 1 to ${MAX_SAMPLES}. Default ${DEFAULT_SAMPLES}.`),
    seed: z.number().int().optional().describe(`Monte Carlo seed. Default ${DEFAULT_SEED} (echoed in the result).`),
    sigmaPerHalfTolerance: z
      .number()
      .positive()
      .optional()
      .describe(
        `Sigmas in a normal contributor's half tolerance. Default ${DEFAULT_SIGMA_PER_HALF_TOLERANCE} (echoed with defaulted: true).`,
      ),
  }),
  run: (doc, params): CommandResult => {
    const command = 'analyze_stackup';
    const { expression, lowerSpecLimit, upperSpecLimit } = params;
    const k = params.sigmaPerHalfTolerance ?? DEFAULT_SIGMA_PER_HALF_TOLERANCE;
    const names = params.contributors.map((c) => c.name);
    if (new Set(names).size !== names.length)
      return refuse(doc, command, 'GDT_STACKUP_INVALID', 'contributor names must be unique', [], ['contributors']);
    if (expression !== undefined && params.contributors.some((c) => c.sensitivity !== undefined))
      return refuse(
        doc,
        command,
        'GDT_STACKUP_SENSITIVITY_CONFLICT',
        'give either expression or sensitivities, not both',
        [],
        ['expression'],
      );
    if ((params.samples ?? DEFAULT_SAMPLES) > MAX_SAMPLES)
      return refuse(doc, command, 'GDT_STACKUP_SAMPLES_CAP', `samples ${params.samples} exceed ${MAX_SAMPLES}`, [], ['samples']);
    if (lowerSpecLimit !== undefined && upperSpecLimit !== undefined && lowerSpecLimit > upperSpecLimit)
      return refuse(doc, command, 'GDT_STACKUP_INVALID', 'lowerSpecLimit exceeds upperSpecLimit', [], ['lowerSpecLimit']);
    const resolved: Resolved[] = [];
    const linked: PmiItem[] = [];
    for (const [index, c] of params.contributors.entries()) {
      const path = `contributors.${index}`;
      let { nominal, lower, upper } = c;
      if (c.pmiId !== undefined) {
        const item = findPmi(doc, c.pmiId);
        if (item === undefined) return refuse(doc, command, 'GDT_PMI_UNKNOWN', `no PMI item '${c.pmiId}'`, [c.pmiId], [`${path}.pmiId`]);
        const derived = toleranceBasis(item);
        if (typeof derived === 'string')
          return refuse(doc, command, 'GDT_STACKUP_CONTRIBUTOR_UNTOLERANCED', derived, [c.pmiId], [`${path}.pmiId`]);
        ({ nominal, lower, upper } = derived);
        linked.push(item);
      }
      if (
        nominal === undefined ||
        lower === undefined ||
        upper === undefined ||
        ![nominal, lower, upper].every(Number.isFinite) ||
        lower > upper
      )
        return refuse(
          doc,
          command,
          'GDT_STACKUP_INVALID',
          `contributor '${c.name}': nominal, lower and upper must be finite with lower <= upper`,
          [],
          [path],
        );
      if (expression !== undefined && !IDENTIFIER.test(c.name))
        return refuse(
          doc,
          command,
          'GDT_STACKUP_EXPRESSION',
          `contributor name '${c.name}' is not a plain identifier`,
          [],
          [`${path}.name`],
        );
      const distribution: StackDistribution = c.distribution ?? 'normal';
      resolved.push({
        contributor: { name: c.name, nominal, lower, upper, sensitivity: c.sensitivity ?? 1, distribution },
        verified: c.verified ?? c.pmiId !== undefined,
        source: c.pmiId === undefined ? 'typed' : `pmi ${c.pmiId}`,
        unit: c.unit ?? 'length',
      });
    }
    let items = resolved.map((r) => r.contributor);
    const means = items.map(meanOf);
    let evaluate = (values: readonly number[]): number => values.reduce((sum, v, i) => sum + (items[i]?.sensitivity ?? 1) * v, 0);
    let nominal = items.reduce((sum, c) => sum + c.sensitivity * c.nominal, 0);
    let mean = items.reduce((sum, c) => sum + c.sensitivity * meanOf(c), 0);
    if (expression !== undefined) {
      const parsed = parseStackExpression(expression, names);
      if (!parsed.ok) return refuse(doc, command, 'GDT_STACKUP_EXPRESSION', parsed.error, [], ['expression']);
      const f = compileStackExpression(parsed.tree);
      const atMeans = stackGradient(parsed.tree, means);
      const atNominal = f(items.map((c) => c.nominal));
      if (!Number.isFinite(atMeans.value) || !Number.isFinite(atNominal) || atMeans.gradient.some((g) => !Number.isFinite(g)))
        return refuse(doc, command, 'GDT_STACKUP_EXPRESSION', 'the expression is not finite at the contributor values', [], ['expression']);
      items = items.map((c, i) => ({ ...c, sensitivity: atMeans.gradient[i] ?? 0 }));
      evaluate = f;
      nominal = atNominal;
      mean = atMeans.value;
    }
    const wcHalf = worstCaseHalf(items);
    const rss = rssHalf(items);
    const sigma = stackSigma(items, k);
    const corners = exactCorners(items, evaluate);
    const probability = exactProbabilities(items, mean, k, lowerSpecLimit, upperSpecLimit);
    const methods = params.methods ?? ['worstCase', 'rss'];
    const samples = params.samples ?? DEFAULT_SAMPLES;
    const seed = params.seed ?? DEFAULT_SEED;
    const mc = methods.includes('monteCarlo')
      ? monteCarlo(items, evaluate, {
          seed,
          samples,
          sigmaPerHalfTolerance: k,
          ...(lowerSpecLimit === undefined ? {} : { lower: lowerSpecLimit }),
          ...(upperSpecLimit === undefined ? {} : { upper: upperSpecLimit }),
          sigma,
        })
      : null;
    const unverified = resolved.filter((r) => !r.verified).map((r) => r.contributor.name);
    const reviewing = linked.filter((item) => item.review.required).map((item) => item.id);
    const reasons = [
      ...(unverified.length > 0
        ? [`unverified contributors: ${unverified.join(', ')} (typed limits not confirmed against their source)`]
        : []),
      ...(reviewing.length > 0 ? [`PMI items awaiting engineer review: ${reviewing.join(', ')}`] : []),
    ];
    const fmt = (v: number): string => String(Number(v.toPrecision(9)));
    const data = {
      ...(params.name === undefined ? {} : { name: params.name }),
      unit: doc.units,
      nominal,
      mean,
      worstCase: { min: mean - wcHalf, max: mean + wcHalf, halfTolerance: wcHalf },
      worstCaseExactCorners: corners,
      rss: { halfTolerance: rss, min: mean - rss, max: mean + rss },
      sigma,
      pBelow: lowerSpecLimit === undefined ? null : (probability?.pBelow ?? null),
      pAbove: upperSpecLimit === undefined ? null : (probability?.pAbove ?? null),
      probabilityMethod:
        probability?.method ?? 'not available in closed form (mixed distributions or too many uniform terms): use monteCarlo',
      contributions: contributions(items, k),
      contributors: resolved.map((r, i) => ({
        name: r.contributor.name,
        nominal: r.contributor.nominal,
        lower: r.contributor.lower,
        upper: r.contributor.upper,
        halfTolerance: halfOf(r.contributor),
        sensitivity: items[i]?.sensitivity ?? r.contributor.sensitivity,
        distribution: r.contributor.distribution,
        unit: r.unit,
        source: r.source,
        verified: r.verified,
      })),
      ...(mc === null
        ? {}
        : {
            monteCarlo: {
              ...mc,
              acceptance: {
                ...mc.acceptance,
                ...(lowerSpecLimit !== undefined && probability !== null
                  ? { pBelow: probabilityAcceptance(probability.pBelow, samples) }
                  : {}),
              },
            },
          }),
      sigmaPerHalfTolerance: {
        value: k,
        source: 'llull named default (3 sigma per half tolerance)',
        defaulted: params.sigmaPerHalfTolerance === undefined,
      },
      provenance: {
        method:
          expression === undefined
            ? 'linear stack with given sensitivities'
            : 'expression with exact derivatives at the contributor means (linearised worst case and RSS)',
        formulas: [
          'worst case = mean +- sum |a_i| t_i',
          'RSS = mean +- sqrt(sum (a_i t_i)^2)',
          'sigma = sqrt(sum (a_i sigma_i)^2), sigma_i = t_i / k (normal) or t_i / sqrt(3) (uniform)',
        ],
        sensitivitySource: expression === undefined ? 'given' : 'autodiff',
        ...(expression === undefined ? {} : { expression }),
        ...(expression === undefined && params.contributors.every((c) => c.sensitivity === undefined)
          ? { note: 'no sensitivities given: every contributor counts +1' }
          : {}),
      },
      ...(unverified.length > 0 ? { unverified: { contributors: unverified } } : {}),
      reviewRequired: reasons.length > 0,
      ...(reasons.length > 0 ? { reviewReason: reasons.join('; ') } : {}),
      ...(unverified.length > 0
        ? {
            warnings: [
              {
                code: 'GDT_UNVERIFIED_INPUT',
                message: `unverified contributors: ${unverified.join(', ')}`,
                remediation: 'link the contributor to a PMI item or confirm the value with its source',
              },
            ],
          }
        : {}),
    };
    const summary =
      `analyze_stackup${params.name === undefined ? '' : ` "${params.name}"`}: nominal ${fmt(nominal)}, mean ${fmt(mean)} ${doc.units}; worst case ${fmt(data.worstCase.min)} … ${fmt(data.worstCase.max)}; ` +
      `RSS ±${fmt(rss)} (sigma ${fmt(sigma)})${data.pBelow === null ? '' : `; P(below ${lowerSpecLimit}) ${data.pBelow.toExponential(4)}`}${data.pAbove === null ? '' : `; P(above ${upperSpecLimit}) ${data.pAbove.toExponential(4)}`}` +
      `${mc === null ? '' : `; Monte Carlo ${samples} samples seed ${seed}: mean ${fmt(mc.mean)} std ${fmt(mc.std)}`}` +
      `${unverified.length > 0 ? `; unverified: ${unverified.join(', ')}` : ''}${reasons.length > 0 ? '; needs review by a qualified engineer' : ''}.`;
    return report(doc, summary, data);
  },
});
