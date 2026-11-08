/** Evaluation of one performance index of one material (PHY-01 / 08 values, base units, no imputation). */

import { BASE_UNITS, exponentValue, indexUnit, type IndexRule } from './indexRules';
import { issue } from './codes';
import { anisotropicWarning, resolveCandidateProperty, type Layup } from './layups';
import type { ResolveOptions } from './properties';
import type { CadDocument } from '@core/model/types';
import type { Excluded, IndexResult, PropertyUse, StrengthProperty } from './types';

export interface IndexOptions extends ResolveOptions {
  readonly strengthProperty?: StrengthProperty | undefined;
  /** The layup a lamina candidate is compared through. */
  readonly layup?: Layup | undefined;
}

/** The unverified warning a result carries (not suppressible, SEL_VALUE_UNVERIFIED). */
export function unverifiedWarning(material: string, inputs: readonly PropertyUse[]): IndexResult['warnings'] {
  const weak = inputs.filter((input) => input.unverified);
  return weak.length === 0
    ? []
    : [
        issue(
          'SEL_VALUE_UNVERIFIED',
          'warning',
          `'${material}': ${weak.map((input) => `${input.property} (${input.unverifiedReasons.join(', ')})`).join('; ')}`,
          weak.map((input) => `${material}/${input.propertyValueId}`),
        ),
      ];
}

/**
 * P^n / rho of `material` for `rule`: P is E (GPa) or the named strength (MPa), rho in Mg/m^3.
 * @failure a missing / ambiguous / out-of-range input -> Excluded with the code and the property names (never a guess)
 */
export function evaluateIndex(doc: CadDocument, material: string, rule: IndexRule, options: IndexOptions): IndexResult | Excluded {
  const property = rule.property === 'E' ? 'E' : options.strengthProperty;
  if (property === undefined)
    return { material, code: 'SEL_STRENGTH_PROPERTY_UNSET', reason: `${rule.case} needs a strength property`, missing: [] };
  const asked: ResolveOptions = { direction: options.direction, thickness: options.thickness, temperature: options.temperature };
  const pValue = resolveCandidateProperty(doc, material, property, BASE_UNITS[rule.property], asked, options.layup);
  const density = resolveCandidateProperty(doc, material, 'density', BASE_UNITS.density, asked, options.layup);
  if (!pValue.ok || !density.ok) {
    const failures = [pValue, density].flatMap((entry) => (entry.ok ? [] : [entry]));
    return {
      material,
      code: failures[0]?.code ?? 'SEL_PROPERTY_MISSING',
      reason: failures.map((failure) => failure.reason).join('; '),
      missing: failures.map((failure) => failure.property),
    };
  }
  const inputs = [pValue.use, density.use];
  const value = Math.pow(pValue.use.value, exponentValue(rule)) / density.use.value;
  if (!Number.isFinite(value) || !(value > 0))
    return {
      material,
      code: 'SEL_PROPERTY_MISSING',
      reason: `${property} = ${pValue.use.value} ${pValue.use.unit}, density = ${density.use.value} ${density.use.unit} give no positive index`,
      missing: [property, 'density'],
    };
  const reasons = [...new Set(inputs.flatMap((input) => input.unverifiedReasons.map((reason) => `${input.property}: ${reason}`)))];
  return {
    material,
    case: rule.case,
    value,
    unit: indexUnit(rule),
    inputs,
    unverified: inputs.some((input) => input.unverified),
    unverifiedReasons: reasons,
    warnings: [
      ...unverifiedWarning(material, inputs),
      ...(options.layup === undefined ? [] : [anisotropicWarning(material, options.layup)]),
    ],
    provenance: { rule: rule.source, derivation: rule.derivation },
  };
}

export const isExcluded = (value: IndexResult | Excluded): value is Excluded => 'code' in value;
