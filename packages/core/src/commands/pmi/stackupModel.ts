/**
 * The stack-up model shared by `analyze_stackup` (TS Monte Carlo up to STACKUP_TS_SAMPLES_CAP) and the host transport
 * `stackup_monte_carlo` (native `llull-compute stats` above it): params schema, validation into a sampled program (contributors typed or
 * linked to a PMI size / location dimension by `pmiId`, M7 FR-GDT-18), and the result data.
 */

import { compileExpression, linearProgram, programFunction, programIsBitExact, type Program } from '../../lib/expressionProgram';
import { isIdentifier } from '../../lib/identifier';
import {
  centreOf,
  halfToleranceOf,
  monteCarloAcceptance,
  probabilityAbove,
  probabilityBelow,
  sigmaOf,
  stackClosedForms,
  type StackInput,
} from '../../lib/stackup';
import type { SampledContributor, SamplingStats } from '../../lib/stackupSampling';
import { z } from '../schema';
import type { CadDocument } from '../../model/types';
import { toleranceBasis } from '../../geometry/pmiText';
import { findPmi } from './pmiOps';

export const STACKUP_TS_SAMPLES_CAP = 2_000_000;
export const STACKUP_DEFAULT_SAMPLES = 100_000;
const DEFAULT_SEED = 1;
const DEFAULT_SIGMA_PER_HALF_TOLERANCE = 3;
const MAX_CONTRIBUTORS = 64;

export const stackupParams = z.object({
  name: z.string().optional().describe('Display name of the stack, e.g. "housing gap".'),
  contributors: z
    .array(
      z.object({
        name: z.string().describe('Identifier used in `expression` (letters, digits, underscore; not starting with a digit), unique.'),
        nominal: z
          .number()
          .optional()
          .describe(
            'Nominal value in document length units (degrees for angles). Required unless pmiId is given (then measured from the PMI item).',
          ),
        upper: z
          .number()
          .optional()
          .describe('Upper deviation from the nominal, signed (e.g. +0.1, or -0.007 for a shaft). Required unless pmiId is given.'),
        lower: z
          .number()
          .optional()
          .describe('Lower deviation from the nominal, signed (e.g. -0.1); lower <= upper. Required unless pmiId is given.'),
        sensitivity: z
          .number()
          .optional()
          .describe(
            'Linear stack only: coefficient a_i of this contributor (y = Σ a_i x_i). Give it on every contributor, or use expression.',
          ),
        distribution: z
          .enum(['normal', 'uniform'])
          .optional()
          .describe('normal (default: σ = half tolerance / sigmaPerHalfTolerance) or uniform over the limits (σ = t/√3).'),
        verified: z
          .boolean()
          .optional()
          .describe('false marks a hand-typed value not confirmed against its source: it is listed in data.unverified (never hidden).'),
        unit: z.enum(['length', 'deg']).optional().describe('length (default, document unit) or deg for an angle (reported only).'),
        pmiId: z
          .string()
          .optional()
          .describe(
            'Id of a PMI size or location dimension whose measured nominal and tolerance feed this contributor (limits become deviations); the stack follows the PMI.',
          ),
      }),
    )
    .describe('Contributors (1..64), each with nominal and signed limits; the mean is nominal + (upper + lower)/2.'),
  expression: z
    .string()
    .optional()
    .describe(
      'y = f(contributors), e.g. "H - (A + B + C + D)" or "L * sin(theta * pi / 180)" (an optional "gap = " prefix is ignored). Grammar: + - * / ( ), ' +
        'numbers, pi, tau, sin cos tan asin acos atan atan2 sqrt abs exp ln log10 pow hypot min max floor ceil round trunc sign mod. ' +
        'Sensitivities come from exact automatic differentiation. Give either expression or a sensitivity on every contributor.',
    ),
  methods: z
    .array(z.enum(['worstCase', 'rss', 'monteCarlo']))
    .optional()
    .describe('Methods to report. Default ["worstCase", "rss"]; add "monteCarlo" for sampling (seeded, deterministic).'),
  lowerSpecLimit: z.number().optional().describe('Lower specification limit L of y: reports P(y < L).'),
  upperSpecLimit: z.number().optional().describe('Upper specification limit U of y: reports P(y > U).'),
  samples: z
    .number()
    .int()
    .optional()
    .describe(
      'Monte Carlo samples, >= 1000. Default 100000; analyze_stackup caps at 2000000 (above: the native stackup_monte_carlo tool).',
    ),
  seed: z.number().int().optional().describe('Monte Carlo seed, integer 0..2^53-1 (Philox4x32-10 key). Default 1 (reported as defaulted).'),
  sigmaPerHalfTolerance: z
    .number()
    .optional()
    .describe('k in σ = half tolerance / k for normal contributors, > 0. Default 3 (±3σ = the limits), reported as defaulted.'),
});

export type StackupParams = z.infer<typeof stackupParams>;

export interface StackupRefusal {
  readonly code: string;
  readonly message: string;
  readonly paths: readonly string[];
}

/** Where a contributor's numbers come from: typed, or a PMI item (measured nominal, its tolerance). */
export interface ContributorSource {
  readonly source: string;
  readonly verified: boolean;
  readonly unit: 'length' | 'deg';
}

export interface StackupModel {
  readonly params: StackupParams;
  readonly contributors: readonly StackInput[];
  readonly sources: readonly ContributorSource[];
  /** Linked PMI items still awaiting a qualified reviewer (AF-33). */
  readonly pmiAwaitingReview: readonly string[];
  readonly program: Program;
  readonly linear: boolean;
  readonly sensitivitySource: 'given' | 'autodiff';
  readonly sigmaPerHalfTolerance: number;
  readonly methods: ReadonlySet<'worstCase' | 'rss' | 'monteCarlo'>;
  readonly samples: number;
  readonly seed: number;
}

const refusal = (code: string, message: string, paths: readonly string[]): StackupRefusal => ({ code, message, paths });

export const isStackupRefusal = (value: StackupModel | StackupRefusal): value is StackupRefusal => 'code' in value;

interface Resolved {
  readonly nominal: number;
  readonly lower: number;
  readonly upper: number;
  readonly source: ContributorSource;
}

/** The numbers of each contributor: typed, or measured from its PMI item (`pmiId`); a refusal when a link or a typed value is unusable. */
function resolveContributors(
  params: StackupParams,
  doc: CadDocument | undefined,
): { readonly values: Resolved[]; readonly awaiting: string[] } | StackupRefusal {
  const values: Resolved[] = [];
  const awaiting: string[] = [];
  for (const [index, c] of params.contributors.entries()) {
    const path = `contributors.${index}`;
    let { nominal, lower, upper } = c;
    let unit = c.unit ?? 'length';
    if (c.pmiId !== undefined) {
      const item = doc === undefined ? undefined : findPmi(doc, c.pmiId);
      if (item === undefined) return refusal('GDT_PMI_UNKNOWN', `no PMI item '${c.pmiId}'`, [`${path}.pmiId`]);
      const derived = toleranceBasis(item);
      if (typeof derived === 'string') return refusal('GDT_STACKUP_CONTRIBUTOR_UNTOLERANCED', derived, [`${path}.pmiId`]);
      ({ nominal, lower, upper } = derived);
      if (item.kind === 'location_dimension' && item.measure === 'angle') unit = 'deg';
      if (item.review.required) awaiting.push(item.id);
    }
    if (nominal === undefined || lower === undefined || upper === undefined || ![nominal, lower, upper].every(Number.isFinite))
      return refusal('GDT_STACKUP_CONTRIBUTOR_INVALID', `${c.name}: nominal, upper and lower must be finite numbers (or give pmiId)`, [
        path,
      ]);
    values.push({
      nominal,
      lower,
      upper,
      source: { source: c.pmiId === undefined ? 'typed' : `pmi ${c.pmiId}`, verified: c.verified !== false, unit },
    });
  }
  return { values, awaiting };
}

/**
 * Validates the params into a model; `samplesCap` is the TS cap (analyze_stackup) or the native cap (the transport). `doc` resolves
 * `pmiId` contributors (without it a link is refused).
 * @failure see the GDT_STACKUP_* / GDT_LIMITS_INVERTED / GDT_PMI_UNKNOWN codes of `codes.ts`
 */
export function resolveStackup(params: StackupParams, samplesCap: number, doc?: CadDocument): StackupModel | StackupRefusal {
  if (params.contributors.length === 0 || params.contributors.length > MAX_CONTRIBUTORS)
    return refusal('GDT_STACKUP_CONTRIBUTOR_INVALID', `give 1..${MAX_CONTRIBUTORS} contributors`, ['contributors']);
  const resolved = resolveContributors(params, doc);
  if ('code' in resolved) return resolved;
  const list = params.contributors.map((c, i) => ({ ...c, ...(resolved.values[i] as Resolved) }));
  const names = list.map((c) => c.name);
  const badName = names.findIndex((name, i) => !isIdentifier(name) || names.indexOf(name) !== i);
  if (badName >= 0)
    return refusal('GDT_STACKUP_CONTRIBUTOR_INVALID', `contributor name "${names[badName]}" is not a unique identifier`, [
      `contributors.${badName}.name`,
    ]);
  const inverted = list.findIndex((c) => c.lower > c.upper);
  if (inverted >= 0) return refusal('GDT_LIMITS_INVERTED', `${names[inverted]}: lower > upper`, [`contributors.${inverted}.lower`]);
  const withSensitivity = list.filter((c) => c.sensitivity !== undefined).length;
  const given = params.expression !== undefined;
  if (given === withSensitivity > 0 || (!given && withSensitivity !== list.length))
    return refusal(
      'GDT_STACKUP_SENSITIVITY_CONFLICT',
      given ? 'both expression and sensitivities are given' : 'give an expression or a sensitivity on every contributor',
      ['expression'],
    );
  let program: Program;
  if (params.expression !== undefined) {
    const compiled = compileExpression(params.expression.replace(/^\s*[A-Za-z_]\w*\s*=/, ''), names);
    if (typeof compiled === 'string') return refusal('GDT_STACKUP_EXPRESSION', compiled, ['expression']);
    const f = programFunction(compiled);
    if (!Number.isFinite(f(list.map((c) => c.nominal))) || !Number.isFinite(f(list.map((c) => c.nominal + (c.lower + c.upper) / 2))))
      return refusal('GDT_STACKUP_NON_FINITE', 'the expression is not finite at the contributor nominals / means', ['expression']);
    program = compiled;
  } else program = linearProgram(list.map((c) => c.sensitivity as number));
  const k = params.sigmaPerHalfTolerance ?? DEFAULT_SIGMA_PER_HALF_TOLERANCE;
  if (!(k > 0 && Number.isFinite(k)))
    return refusal('GDT_STACKUP_PARAM_INVALID', 'sigmaPerHalfTolerance must be > 0', ['sigmaPerHalfTolerance']);
  const samples = params.samples ?? STACKUP_DEFAULT_SAMPLES;
  const methods = new Set(params.methods ?? (['worstCase', 'rss'] as const));
  if (methods.has('monteCarlo') && (samples < 1000 || samples > samplesCap))
    return refusal('GDT_STACKUP_SAMPLES_CAP', `samples ${samples} outside 1000..${samplesCap}`, ['samples']);
  const { lowerSpecLimit, upperSpecLimit } = params;
  if (lowerSpecLimit !== undefined && upperSpecLimit !== undefined && lowerSpecLimit > upperSpecLimit)
    return refusal('GDT_LIMITS_INVERTED', 'lowerSpecLimit exceeds upperSpecLimit', ['lowerSpecLimit']);
  const seed = params.seed ?? DEFAULT_SEED;
  if (seed < 0 || seed > Number.MAX_SAFE_INTEGER) return refusal('GDT_STACKUP_PARAM_INVALID', 'seed must be 0..2^53-1', ['seed']);
  return {
    params,
    contributors: list.map((c) => ({
      name: c.name,
      nominal: c.nominal,
      lower: c.lower,
      upper: c.upper,
      distribution: c.distribution ?? 'normal',
    })),
    sources: resolved.values.map((value) => value.source),
    pmiAwaitingReview: resolved.awaiting,
    program,
    linear: !given,
    sensitivitySource: given ? 'autodiff' : 'given',
    sigmaPerHalfTolerance: k,
    methods,
    samples,
    seed,
  };
}

/** The contributors as the sampler (TS and native) draws them. */
export const sampledContributors = (model: StackupModel): SampledContributor[] =>
  model.contributors.map((c) => ({
    centre: centreOf(c),
    half: halfToleranceOf(c),
    sigma: sigmaOf(c, model.sigmaPerHalfTolerance),
    distribution: c.distribution,
  }));

/** `job.json` of `llull-compute stats` (crate `llull-stats`): the sampled contributors and the program, as the TS sampler uses them. */
export const stackupJob = (model: StackupModel): Record<string, unknown> => ({
  samples: model.samples,
  seed: model.seed,
  contributors: sampledContributors(model),
  program: model.program,
  ...(model.params.lowerSpecLimit === undefined ? {} : { lowerSpecLimit: model.params.lowerSpecLimit }),
  ...(model.params.upperSpecLimit === undefined ? {} : { upperSpecLimit: model.params.upperSpecLimit }),
});

export interface MonteCarloRun {
  readonly stats: SamplingStats;
  readonly engine: 'ts' | 'native';
  readonly provenance?: Readonly<Record<string, unknown>>;
}

/** The `data` of analyze_stackup / stackup_monte_carlo. */
export function stackupData(model: StackupModel, unit: string, monteCarlo: MonteCarloRun | null): Record<string, unknown> {
  const forms = stackClosedForms(model.contributors, model.program, model.sigmaPerHalfTolerance);
  const { lowerSpecLimit: lsl, upperSpecLimit: usl } = model.params;
  const below = lsl === undefined ? null : probabilityBelow(lsl, forms, model.contributors, model.linear);
  const above = usl === undefined ? null : probabilityAbove(usl, forms, model.contributors, model.linear);
  const pAbove = above === null ? null : above.p;
  const unverified = model.contributors.filter((_, i) => model.sources[i]?.verified === false).map((c) => c.name);
  const linearised = !model.linear && !forms.sensitivities.every(Number.isFinite);
  const reasons = [
    ...(unverified.length > 0 ? [`unverified contributors: ${unverified.join(', ')}`] : []),
    ...(!model.linear ? ['non-linear expression: worst case and RSS are linearised at the means; check exact corners / Monte Carlo'] : []),
    ...(model.pmiAwaitingReview.length > 0 ? [`PMI items awaiting engineer review: ${model.pmiAwaitingReview.join(', ')}`] : []),
    ...(linearised ? ['a sensitivity is not finite at the means'] : []),
  ];
  const k = model.sigmaPerHalfTolerance;
  return {
    ...(model.params.name !== undefined ? { name: model.params.name } : {}),
    unit,
    yNominal: forms.yNominal,
    yMean: forms.yMean,
    ...(model.methods.has('worstCase') ? { worstCase: forms.worstCase, worstCaseExactCorners: forms.worstCaseExactCorners } : {}),
    ...(model.methods.has('rss') ? { rss: forms.rss } : {}),
    sigma: forms.sigma,
    ...(below === null ? {} : { pBelowLowerLimit: below.p, pMethod: below.method }),
    ...(above === null ? {} : { pAboveUpperLimit: pAbove, ...(below === null ? { pMethod: above.method } : {}) }),
    contributions: forms.contributions.map((row, i) => ({
      ...row,
      sensitivity: forms.sensitivities[i],
      ...(model.sources[i]?.unit === 'deg' ? { unit: 'deg' } : {}),
    })),
    contributors: model.contributors.map((c, i) => ({
      name: c.name,
      nominal: c.nominal,
      lower: c.lower,
      upper: c.upper,
      halfTolerance: halfToleranceOf(c),
      sensitivity: forms.sensitivities[i],
      distribution: c.distribution,
      unit: model.sources[i]?.unit ?? 'length',
      source: model.sources[i]?.source ?? 'typed',
      verified: model.sources[i]?.verified ?? true,
    })),
    ...(monteCarlo === null
      ? {}
      : { monteCarlo: monteCarloBlock(model, forms.sigma, { below: below?.p ?? null, above: pAbove }, monteCarlo) }),
    sigmaPerHalfTolerance: {
      value: k,
      source: model.params.sigmaPerHalfTolerance === undefined ? 'llull default: ±3σ per half tolerance' : 'given',
      defaulted: model.params.sigmaPerHalfTolerance === undefined,
    },
    provenance: {
      method: [...model.methods].join('+'),
      formulas: 'GDT TECHNICAL_SPEC §5.7: WC = Σ|a_i| t_i; RSS = √Σ(a_i t_i)²; σ_y = √Σ(a_i σ_i)²; normal P = Φ((L − ȳ)/σ_y)',
      sensitivitySource: model.sensitivitySource,
    },
    ...(unverified.length > 0 ? { unverified: { contributors: unverified } } : {}),
    warnings:
      unverified.length > 0
        ? [
            {
              code: 'GDT_UNVERIFIED_INPUT',
              ids: unverified,
              remediation: 'link the contributor to a PMI item or confirm the value with its source',
            },
          ]
        : [],
    reviewRequired: reasons.length > 0,
    ...(reasons.length > 0 ? { reviewReason: reasons.join('; ') } : {}),
  };
}

function monteCarloBlock(
  model: StackupModel,
  sigma: number,
  p: { readonly below: number | null; readonly above: number | null },
  run: MonteCarloRun,
): Record<string, unknown> {
  const { stats } = run;
  return {
    seed: model.seed,
    seedDefaulted: model.params.seed === undefined,
    samples: stats.samples,
    samplesDefaulted: model.params.samples === undefined,
    prng: 'philox4x32-10',
    engine: run.engine,
    bitExactWithTs: run.engine === 'ts' || programIsBitExact(model.program),
    mean: stats.mean,
    std: stats.std,
    min: stats.min,
    max: stats.max,
    ...(model.params.lowerSpecLimit === undefined ? {} : { pBelowLowerLimit: stats.below / stats.samples }),
    ...(model.params.upperSpecLimit === undefined ? {} : { pAboveUpperLimit: stats.above / stats.samples }),
    acceptance: {
      ...monteCarloAcceptance(sigma, stats.samples, p.below),
      ...(p.above === null ? {} : { pAboveTolerance: monteCarloAcceptance(sigma, stats.samples, p.above).pTolerance }),
    },
    ...(run.provenance === undefined ? {} : { provenance: run.provenance }),
  };
}
