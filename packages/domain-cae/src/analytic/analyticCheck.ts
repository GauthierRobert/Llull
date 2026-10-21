/** hand_check, structural part: closed-form reference values to compare an FE result with (05 §4, FR-FEA-21, AF-35). */

import { codedRejection, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { significantNumber } from '@lib/compactNumber';
import { ANALYTIC_CHECKS, type CheckSpec, type InputSpec } from './formulas';

export const STRUCTURAL_CHECK_NAMES = Object.keys(ANALYTIC_CHECKS) as [string, ...string[]];

interface HandCheckComparison {
  readonly quantity: string;
  readonly value: number;
  readonly toleranceRel?: number | undefined;
}

const inputList = (specs: readonly InputSpec[]): string => specs.map((spec) => `${spec.key} [${spec.unit}]`).join(', ') || 'none';

/** One line per check for the tool description: required and optional input keys with units. */
export const STRUCTURAL_CHECK_CATALOG = STRUCTURAL_CHECK_NAMES.map((name) => {
  const spec = ANALYTIC_CHECKS[name] as CheckSpec;
  const extra = spec.oneOf === undefined ? '' : `; at least one of ${spec.oneOf.join(' / ')}`;
  return `${name}: ${spec.summary} Inputs: ${inputList(spec.required)}; optional: ${inputList(spec.optional)}${extra}.`;
}).join(' ');

const problemOf = (spec: InputSpec, value: number): string | null => {
  const [low, high] = spec.range ?? [0, Number.POSITIVE_INFINITY];
  const inside = spec.range === undefined ? value > 0 : spec.open === true ? value > low && value < high : value >= low && value <= high;
  if (!inside)
    return `${spec.key} = ${value} is outside its range ${spec.range === undefined ? '> 0' : `${spec.open === true ? '(' : '['}${low}, ${high}${spec.open === true ? ')' : ']'}`}`;
  return spec.integer === true && !Number.isInteger(value) ? `${spec.key} must be an integer` : null;
};

const REMEDIATION = 'pass every required input of the chosen check with its unit suffix (see the description), as positive finite numbers';

/**
 * @invariant read-only and pure: no document, artifact or kernel is read; every result carries its unit and formula, the assumptions and sources
 *   are returned with it (AF-35); `compare` reports the relative difference to an FE number without declaring a pass unless a tolerance is given
 * @failure unknown / missing / out-of-range input, an input the check does not use, or an unknown `compare.quantity` ->
 *   FEA_ANALYTIC_INPUT_INVALID (refusal, unchanged doc)
 */
export function structuralHandCheck(
  doc: CadDocument,
  { check, inputs, compare }: { check: string; inputs: Readonly<Record<string, number>>; compare?: HandCheckComparison | undefined },
): CommandResult {
  const fail = (message: string): CommandResult =>
    codedRejection(doc, 'hand_check', 'FEA_ANALYTIC_INPUT_INVALID', message, REMEDIATION, []);
  const spec = ANALYTIC_CHECKS[check] as CheckSpec;
  const known = new Map([...spec.required, ...spec.optional].map((entry) => [entry.key, entry]));
  const unknown = Object.keys(inputs).filter((key) => !known.has(key));
  if (unknown.length > 0)
    return fail(
      `${check} does not use ${unknown.join(', ')}; its inputs are ${inputList(spec.required)}; optional ${inputList(spec.optional)}`,
    );
  const missing = spec.required.filter((entry) => !Object.hasOwn(inputs, entry.key));
  if (missing.length > 0) return fail(`${check} needs ${missing.map((entry) => entry.key).join(', ')}`);
  if (spec.oneOf !== undefined && !spec.oneOf.some((key) => Object.hasOwn(inputs, key)))
    return fail(`${check} needs at least one of ${spec.oneOf.join(', ')}`);
  for (const [key, value] of Object.entries(inputs)) {
    const problem = problemOf(known.get(key) as InputSpec, value);
    if (problem !== null) return fail(problem);
  }
  const evaluation = spec.evaluate(inputs);
  let comparison: Record<string, unknown> | null = null;
  if (compare !== undefined) {
    const target = evaluation.results.find((entry) => entry.name === compare.quantity);
    if (target === undefined)
      return fail(
        `${check} has no result '${compare.quantity}'; its results are ${evaluation.results.map((entry) => entry.name).join(', ')}`,
      );
    const difference = target.value === 0 ? Number.NaN : (compare.value - target.value) / target.value;
    comparison = {
      quantity: target.name,
      analytic: target.value,
      fe: compare.value,
      unit: target.unit,
      relativeDifference: Number.isFinite(difference) ? difference : null,
      toleranceRel: compare.toleranceRel ?? null,
      withinTolerance:
        compare.toleranceRel === undefined || !Number.isFinite(difference) ? null : Math.abs(difference) <= compare.toleranceRel,
    };
  }
  const lines = evaluation.results.map((entry) => `${entry.name} = ${significantNumber(entry.value, 6)} ${entry.unit}`);
  const verdict =
    comparison === null
      ? ''
      : ` FE ${significantNumber(compare?.value ?? 0, 6)} vs analytic: ${
          comparison['relativeDifference'] === null
            ? 'no relative difference (analytic value 0)'
            : `${significantNumber(Number(comparison['relativeDifference']) * 100, 3)} %`
        }${comparison['withinTolerance'] === null ? '' : comparison['withinTolerance'] === true ? ', within tolerance' : ', OUTSIDE tolerance'}.`;
  return report(doc, `hand_check ${check}: ${lines.join('; ')}.${verdict} Idealised closed form: ${evaluation.assumptions[0] ?? ''}`, {
    check,
    inputs,
    results: evaluation.results,
    assumptions: evaluation.assumptions,
    sources: evaluation.sources,
    comparison,
  });
}
