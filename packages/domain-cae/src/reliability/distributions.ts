/** Marginal distributions of the random variables: parameter validation, moments, CDF, inverse CDF and the map from a standard normal. */

import { z } from '@core/commands/schema';
import type { Distribution } from '@core/model/probabilistic';
import { gamma, normalCdf, normalInv } from './numerics';

export const distributionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('normal').describe('Normal distribution N(mean, sd).'),
    mean: z.number().describe('Mean, in the variable unit.'),
    sd: z.number().describe('Standard deviation, in the variable unit; must be > 0.'),
  }),
  z.object({
    kind: z.literal('lognormal').describe('Lognormal distribution given by its own mean and standard deviation (not those of ln X).'),
    mean: z.number().describe('Mean of X, in the variable unit; must be > 0.'),
    sd: z.number().describe('Standard deviation of X, in the variable unit; must be > 0.'),
  }),
  z.object({
    kind: z.literal('uniform').describe('Uniform distribution on [min, max].'),
    min: z.number().describe('Lower bound.'),
    max: z.number().describe('Upper bound; must be > min.'),
  }),
  z.object({
    kind: z.literal('weibull').describe('Two-parameter Weibull distribution (F = 1 - exp(-(x/scale)^shape), x >= 0).'),
    shape: z.number().describe('Shape parameter k; must be > 0.'),
    scale: z.number().describe('Scale parameter lambda, in the variable unit; must be > 0.'),
  }),
  z.object({
    kind: z.literal('gumbel').describe('Gumbel (type I largest-value) distribution, F = exp(-exp(-(x - location) / scale)).'),
    location: z.number().describe('Location (mode), in the variable unit.'),
    scale: z.number().describe('Scale parameter beta, in the variable unit; must be > 0.'),
  }),
]) satisfies z.ZodType<Distribution>;

const EULER_GAMMA = 0.5772156649015329;

const lognormalShape = (d: { mean: number; sd: number }): { lambda: number; zeta: number } => {
  const zeta2 = Math.log(1 + (d.sd / d.mean) ** 2);
  return { lambda: Math.log(d.mean) - zeta2 / 2, zeta: Math.sqrt(zeta2) };
};

/** Why `d` is not a valid distribution (finite parameters, sd > 0, lognormal mean > 0, min < max, shape > 0), or null. */
export function distributionIssue(d: Distribution): string | null {
  const numbers = Object.entries(d).filter(([key]) => key !== 'kind');
  const bad = numbers.find(([, value]) => typeof value !== 'number' || !Number.isFinite(value));
  if (bad !== undefined) return `${bad[0]} must be a finite number`;
  switch (d.kind) {
    case 'normal':
      return d.sd > 0 ? null : 'sd must be > 0';
    case 'lognormal':
      return d.mean > 0 && d.sd > 0 ? null : 'lognormal mean and sd must both be > 0';
    case 'uniform':
      return d.min < d.max ? null : 'uniform needs min < max';
    case 'weibull':
      return d.shape > 0 && d.scale > 0 ? null : 'weibull shape and scale must be > 0';
    case 'gumbel':
      return d.scale > 0 ? null : 'gumbel scale must be > 0';
  }
}

/** Mean and standard deviation of X. */
export function momentsOf(d: Distribution): { mean: number; sd: number } {
  switch (d.kind) {
    case 'normal':
    case 'lognormal':
      return { mean: d.mean, sd: d.sd };
    case 'uniform':
      return { mean: (d.min + d.max) / 2, sd: (d.max - d.min) / Math.sqrt(12) };
    case 'weibull': {
      const g1 = gamma(1 + 1 / d.shape);
      return { mean: d.scale * g1, sd: d.scale * Math.sqrt(Math.max(gamma(1 + 2 / d.shape) - g1 * g1, 0)) };
    }
    case 'gumbel':
      return { mean: d.location + EULER_GAMMA * d.scale, sd: (Math.PI * d.scale) / Math.sqrt(6) };
  }
}

/** P(X <= x). */
export function cdf(d: Distribution, x: number): number {
  switch (d.kind) {
    case 'normal':
      return normalCdf((x - d.mean) / d.sd);
    case 'lognormal': {
      const { lambda, zeta } = lognormalShape(d);
      return x <= 0 ? 0 : normalCdf((Math.log(x) - lambda) / zeta);
    }
    case 'uniform':
      return Math.min(Math.max((x - d.min) / (d.max - d.min), 0), 1);
    case 'weibull':
      return x <= 0 ? 0 : 1 - Math.exp(-Math.pow(x / d.scale, d.shape));
    case 'gumbel':
      return Math.exp(-Math.exp(-(x - d.location) / d.scale));
  }
}

/** x with P(X <= x) = p, for p in (0, 1). */
export function invCdf(d: Distribution, p: number): number {
  switch (d.kind) {
    case 'normal':
      return d.mean + d.sd * normalInv(p);
    case 'lognormal': {
      const { lambda, zeta } = lognormalShape(d);
      return Math.exp(lambda + zeta * normalInv(p));
    }
    case 'uniform':
      return d.min + p * (d.max - d.min);
    case 'weibull':
      return d.scale * Math.pow(-Math.log(1 - p), 1 / d.shape);
    case 'gumbel':
      return d.location - d.scale * Math.log(-Math.log(p));
  }
}

/** x = F^-1(Φ(z)) for a standard normal value z (closed form for normal and lognormal, so FORM on them is exact). */
export function fromStandardNormal(d: Distribution, z: number): number {
  if (d.kind === 'normal') return d.mean + d.sd * z;
  if (d.kind === 'lognormal') {
    const { lambda, zeta } = lognormalShape(d);
    return Math.exp(lambda + zeta * z);
  }
  const p = normalCdf(z);
  return invCdf(d, Math.min(Math.max(p, 1e-300), 1 - 1e-16));
}
