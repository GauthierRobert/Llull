/**
 * Probabilistic / reliability data (PHY-18, plugin `cae`): random variables, correlation and limit states recorded on
 * `CadDocument.probabilistic`. Plain JSON; analyses (FORM, Monte Carlo, ...) are queries and store nothing.
 * @invariant a variable's `name` is its key and an expression symbol; failure is g < 0
 */

export type Distribution =
  | { readonly kind: 'normal'; readonly mean: number; readonly sd: number }
  | { readonly kind: 'lognormal'; readonly mean: number; readonly sd: number }
  | { readonly kind: 'uniform'; readonly min: number; readonly max: number }
  | { readonly kind: 'weibull'; readonly shape: number; readonly scale: number }
  | { readonly kind: 'gumbel'; readonly location: number; readonly scale: number };

type VariableBinding = { readonly kind: 'free' } | { readonly kind: 'parameter'; readonly parameter: string };

interface Citation {
  readonly text: string;
  readonly url?: string | undefined;
  readonly locator?: string | undefined;
}

export interface RandomVariable {
  readonly id: string;
  /** Symbol used in limit-state expressions. */
  readonly name: string;
  readonly unit: string;
  readonly distribution: Distribution;
  readonly binding: VariableBinding;
  /** Source of the scatter; absent = unsourced (PRB_SCATTER_UNSOURCED). */
  readonly citation?: Citation;
}

interface NamedTarget {
  readonly value: number;
  readonly source: string;
}

export interface LimitState {
  readonly id: string;
  readonly name: string;
  /** g(x): the part fails when g < 0. */
  readonly expression: string;
  readonly unit: string;
  readonly targetBeta?: NamedTarget;
  readonly targetPf?: NamedTarget;
}

export interface ReliabilityModel {
  readonly variables: Readonly<Record<string, RandomVariable>>;
  readonly variableOrder: readonly string[];
  /** Correlation of x-space values for the listed variables (the rest are independent). */
  readonly correlation?: { readonly names: readonly string[]; readonly matrix: readonly (readonly number[])[] };
  readonly limitStates: Readonly<Record<string, LimitState>>;
  readonly limitStateOrder: readonly string[];
}
