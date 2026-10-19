/**
 * Search driver of the non-linear fits (PHY-02 §5.7, V2): validates `start` and bounds, runs Levenberg-Marquardt from a deterministic list of
 * starts in a fixed order (the user's `start` replaces the list), picks the best converged run by cost (ties by lower parameter norm) and
 * builds the convergence report. Parameters flagged `log` are searched as ln(value) so they stay positive.
 */

import { LM_DEFAULTS, levenbergMarquardt, type LmResult, type LmStop, type Residuals } from './levenbergMarquardt';
import { failure, type LawFailure } from './resolve';

export interface ParamSpec {
  readonly name: string;
  readonly lower: number;
  readonly upper: number;
  /** Search ln(value): the bounds must be > 0. */
  readonly log?: boolean;
}

export interface FitControl {
  /** Parameter values to start from (all of them, by name); replaces the deterministic multi-start. */
  readonly start?: Readonly<Record<string, number>> | undefined;
  /** Per-parameter [lower, upper] overrides (null = keep the default of that side). */
  readonly bounds?: Readonly<Record<string, readonly [number | null, number | null]>> | undefined;
}

export interface ConvergenceReport {
  readonly method: 'levenberg_marquardt';
  readonly converged: boolean;
  readonly stop: LmStop;
  readonly iterations: number;
  readonly evaluations: number;
  readonly starts: { readonly tried: number; readonly converged: number; readonly best: number; readonly source: 'user' | 'grid' };
  /** ½ Σ r² of the weighted residuals. */
  readonly cost: number;
  readonly conditionNumber: number;
  readonly finalDamping: number;
  readonly parameters: ReadonlyArray<{
    readonly name: string;
    readonly value: number;
    readonly lower: number;
    readonly upper: number;
    readonly atBound: boolean;
  }>;
  readonly settings: { readonly initialDamping: number; readonly relativeCostTolerance: number; readonly maxIterations: number };
}

export interface SearchSuccess {
  readonly values: readonly number[];
  readonly report: ConvergenceReport;
}

/** Finite-difference Jacobians resolve collinearity only to ~1e-10, so the bound is 1e8 here (the 1e12 of the QR path cannot be enforced). */
const MAX_CONDITION = 1e8;
const CODE_START = 'MATL_FIT_START_INVALID';

/** Specs with the user's bounds applied; failure for an unknown name or an empty interval. */
function withBounds(specs: readonly ParamSpec[], bounds: FitControl['bounds']): ParamSpec[] | LawFailure {
  if (bounds === undefined) return [...specs];
  const known = new Set(specs.map((spec) => spec.name));
  for (const name of Object.keys(bounds))
    if (!known.has(name))
      return failure(CODE_START, `bounds.${name}`, `unknown parameter '${name}'`, `parameters are: ${[...known].join(', ')}`);
  const out: ParamSpec[] = [];
  for (const spec of specs) {
    const [low, high] = bounds[spec.name] ?? [null, null];
    const next = { ...spec, lower: low ?? spec.lower, upper: high ?? spec.upper };
    if (!(next.lower < next.upper) || (spec.log === true && !(next.lower > 0)))
      return failure(
        CODE_START,
        `bounds.${spec.name}`,
        `bounds [${next.lower}, ${next.upper}] of '${spec.name}' must satisfy lower < upper${spec.log === true ? ' and lower > 0' : ''}`,
      );
    out.push(next);
  }
  return out;
}

/** The user's start as a vector in spec order; failure when names are missing/unknown or a value is outside its bounds. */
function userStart(specs: readonly ParamSpec[], start: Readonly<Record<string, number>>): number[] | LawFailure {
  const names = specs.map((spec) => spec.name);
  const extra = Object.keys(start).filter((name) => !names.includes(name));
  const missing = names.filter((name) => start[name] === undefined);
  if (extra.length > 0 || missing.length > 0)
    return failure(
      CODE_START,
      'start',
      `start needs exactly ${names.join(', ')}${missing.length > 0 ? ` (missing ${missing.join(', ')})` : ''}${extra.length > 0 ? ` (unknown ${extra.join(', ')})` : ''}`,
      'give every parameter once',
    );
  const values: number[] = [];
  for (const spec of specs) {
    const value = start[spec.name] ?? Number.NaN;
    if (!Number.isFinite(value) || value < spec.lower || value > spec.upper)
      return failure(
        CODE_START,
        `start.${spec.name}`,
        `start ${spec.name} = ${value} is outside [${spec.lower}, ${spec.upper}]`,
        'start inside the bounds',
      );
    values.push(value);
  }
  return values;
}

const norm = (values: readonly number[]): number => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));

/**
 * Fit by Levenberg-Marquardt.
 * @param starts deterministic candidate starts in physical units (spec order), tried in order unless `control.start` is given
 * @param residuals weighted residual vector r(p) in physical units, or null when the parameters are invalid
 * @failure bad start / bounds -> MATL_FIT_START_INVALID; no converged run -> MATL_FIT_DID_NOT_CONVERGE; condition > 1e12 -> MATL_FIT_ILL_CONDITIONED
 */
export function searchFit(
  specs: readonly ParamSpec[],
  starts: readonly (readonly number[])[],
  residuals: Residuals,
  control: FitControl,
): SearchSuccess | LawFailure {
  const bounded = withBounds(specs, control.bounds);
  if (!Array.isArray(bounded)) return bounded as LawFailure;
  const parameters = bounded as ParamSpec[];
  let candidates: readonly (readonly number[])[] = starts;
  if (control.start !== undefined) {
    const own = userStart(parameters, control.start);
    if (!Array.isArray(own)) return own as LawFailure;
    candidates = [own];
  }
  const isLog = parameters.map((spec) => spec.log === true);
  const toInternal = (values: readonly number[]): number[] => values.map((value, i) => (isLog[i] === true ? Math.log(value) : value));
  const toPhysical = (values: readonly number[]): number[] => values.map((value, i) => (isLog[i] === true ? Math.exp(value) : value));
  const lower = toInternal(parameters.map((spec) => spec.lower));
  const upper = toInternal(parameters.map((spec) => spec.upper));
  const run = (values: readonly number[]): LmResult =>
    levenbergMarquardt((q) => residuals(toPhysical(q)), toInternal(values), { lower, upper });
  const results = candidates.map((candidate) => ({ result: run(candidate) }));
  const converged = results.filter(({ result }) => result.converged && Number.isFinite(result.cost));
  if (converged.length === 0) {
    const best = results.reduce<LmResult | null>((acc, { result }) => (acc === null || result.cost < acc.cost ? result : acc), null);
    return failure(
      'MATL_FIT_DID_NOT_CONVERGE',
      'law',
      `Levenberg-Marquardt did not converge from ${results.length} start(s) (best cost ${best?.cost.toPrecision(6) ?? 'n/a'}, stop ${best?.stop ?? 'n/a'} after ${best?.iterations ?? 0} iterations)`,
      'give a start closer to the solution, widen the bounds, or use a simpler law',
    );
  }
  let bestIndex = 0;
  converged.forEach(({ result }, index) => {
    const best = converged[bestIndex]?.result;
    if (best === undefined) return;
    const tie = Math.abs(result.cost - best.cost) <= 1e-9 * Math.max(best.cost, Number.MIN_VALUE);
    if (result.cost < best.cost && !tie) bestIndex = index;
    else if (tie && norm(result.params) < norm(best.params)) bestIndex = index;
  });
  const best = converged[bestIndex]?.result as LmResult;
  if (!(best.conditionNumber <= MAX_CONDITION))
    return failure(
      'MATL_FIT_ILL_CONDITIONED',
      'law',
      `the Jacobian at the solution has condition number ${best.conditionNumber.toExponential(2)} > 1e8 after scaling: the data do not identify every parameter`,
      'use fewer terms or a simpler law, or add data in other modes / ranges',
    );
  const values = toPhysical(best.params);
  return {
    values,
    report: {
      method: 'levenberg_marquardt',
      converged: true,
      stop: best.stop,
      iterations: best.iterations,
      evaluations: results.reduce((sum, { result }) => sum + result.evaluations, 0),
      starts: {
        tried: results.length,
        converged: converged.length,
        best: results.indexOf(converged[bestIndex] as (typeof results)[number]),
        source: control.start === undefined ? 'grid' : 'user',
      },
      cost: best.cost,
      conditionNumber: best.conditionNumber,
      finalDamping: best.finalDamping,
      parameters: parameters.map((spec, i) => {
        const value = values[i] ?? 0;
        const near = (bound: number): boolean => Number.isFinite(bound) && Math.abs(value - bound) <= 1e-9 * Math.max(1, Math.abs(bound));
        return { name: spec.name, value, lower: spec.lower, upper: spec.upper, atBound: near(spec.lower) || near(spec.upper) };
      }),
      settings: {
        initialDamping: LM_DEFAULTS.initialDamping,
        relativeCostTolerance: LM_DEFAULTS.relativeCostTolerance,
        maxIterations: LM_DEFAULTS.maxIterations,
      },
    },
  };
}
