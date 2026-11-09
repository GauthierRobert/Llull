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

export interface MaterialPropertyBinding {
  readonly kind: 'materialProperty';
  /** Material id (create_material name) whose PHY-01 property model the scatter comes from. */
  readonly material: string;
  /** Catalogue property name (density, E, k, cte ...). */
  readonly property: string;
  /** Study condition the model is evaluated at (every variable the model needs, each { value, unit }). */
  readonly at?: Readonly<Record<string, { readonly value: number; readonly unit: string }>> | undefined;
  readonly modelId?: string | undefined;
  /** Coverage of a 'measurement' uncertainty band (the model does not carry one). */
  readonly measurementCoverage?: number | undefined;
}

export type VariableBinding =
  | { readonly kind: 'free' }
  | { readonly kind: 'parameter'; readonly parameter: string }
  | MaterialPropertyBinding;

/** What a materialProperty distribution was derived from (snapshot at definition; a replay re-derives it). */
export interface DerivedScatter {
  readonly modelId: string;
  readonly uncertaintyKind: string;
  readonly coverage: number;
  /** Model value y at the study condition (the distribution mean). */
  readonly value: number;
  /** Half-width h of the uncertainty band. */
  readonly halfWidth: number;
  readonly unverifiedReasons: readonly string[];
}

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
  /** Present when the distribution was derived from a PHY-01 uncertainty band (materialProperty binding without a caller distribution). */
  readonly derivedFrom?: DerivedScatter;
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

/** A named scalar read from a read-only registry command (`query.pointer` is an RFC 6901 JSON pointer into its `data`). */
export interface Response {
  readonly id: string;
  readonly name: string;
  readonly unit: string;
  readonly query: { readonly command: string; readonly params: Readonly<Record<string, unknown>>; readonly pointer: string };
}

/** A reviewer's signed acceptance of the reliability result of one limit state (human gate; verified when read). */
export interface Acceptance {
  /** Hash of the model the result was computed on (limitStateModelHash). */
  readonly modelHash: string;
  /** Hash of the result the reviewer saw (resultDigest): the study is re-run from `seed` / `samples` when the acceptance is read. */
  readonly resultHash: string;
  readonly seed: number;
  readonly samples: number;
  readonly justification: string;
  readonly signer: string;
  readonly signatureId: string;
  /** The signature the port verified, kept so readers can re-verify it. */
  readonly signature: unknown;
  readonly documentUid: string;
}

/** Acceptance a human really signed, kept across replay (the recorded step carries no signature). */
export interface AcceptanceLedgerEntry extends Acceptance {
  readonly limitState: string;
}

export interface ReliabilityModel {
  readonly variables: Readonly<Record<string, RandomVariable>>;
  readonly variableOrder: readonly string[];
  /** Correlation of x-space values for the listed variables (the rest are independent). */
  readonly correlation?: { readonly names: readonly string[]; readonly matrix: readonly (readonly number[])[] };
  readonly limitStates: Readonly<Record<string, LimitState>>;
  readonly limitStateOrder: readonly string[];
  /** Absent until the first `define_response`. */
  readonly responses?: Readonly<Record<string, Response>>;
  readonly responseOrder?: readonly string[];
  /** Acceptances by limit state name (accept_reliability_result). */
  readonly acceptances?: Readonly<Record<string, Acceptance>>;
  /** Kept by replaySeed so a replayed accept_reliability_result re-applies its verified act. */
  readonly acceptanceLedger?: readonly AcceptanceLedgerEntry[];
}

declare module '@core/model/documentExtensions' {
  interface DocumentExtensions {
    /** Absent until the first probabilistic command (`define_random_variable`; plugin `cae`, PHY-18). */
    probabilistic?: ReliabilityModel;
  }
}
