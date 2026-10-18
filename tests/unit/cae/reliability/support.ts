import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

export type Json = Record<string, unknown>;
export const data = (result: { data?: unknown }): Json => (result.data ?? {}) as Json;
export const code = (result: { error?: { code: string } }): string | undefined => result.error?.code;
export const relative = (actual: number, expected: number): number => Math.abs(actual / expected - 1);

export interface VariableSpec {
  readonly name: string;
  readonly distribution: Json;
  readonly cited?: boolean;
}

export const normal = (name: string, mean: number, sd: number, cited = true): VariableSpec => ({
  name,
  distribution: { kind: 'normal', mean, sd },
  cited,
});
export const lognormal = (name: string, mean: number, sd: number): VariableSpec => ({
  name,
  distribution: { kind: 'lognormal', mean, sd },
});

/** A document holding the given random variables and one limit state `g`. */
export function modelDoc(variables: readonly VariableSpec[], expression: string, limit: Json = {}, base?: CadDocument): CadDocument {
  let doc = base ?? createEmptyDocument();
  for (const variable of variables)
    doc = execute(doc, 'define_random_variable', {
      name: variable.name,
      unit: 'MPa',
      distribution: variable.distribution,
      ...(variable.cited === false ? {} : { citation: { text: 'test input' } }),
    }).document;
  return execute(doc, 'define_limit_state', { name: 'g', expression, unit: 'MPa', ...limit }).document;
}

/** VC-PRB-01: R ~ N(300, 30), S ~ N(200, 40) MPa, g = R - S. */
export const rMinusS = (limit: Json = {}): CadDocument => modelDoc([normal('R', 300, 30), normal('S', 200, 40)], 'R - S', limit);
