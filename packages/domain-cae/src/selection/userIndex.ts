/** User-defined index (PHY-12 FR-SEL-06, TR-SEL-15): prod(P_i ^ a_i) / rho with a mandatory derivation note. */

import { catalogEntry } from '@core/model/propertyCatalog';
import type { CadDocument } from '@core/model/types';
import { unverifiedWarning, type IndexOptions } from './indices';
import { resolveCandidateProperty, anisotropicWarning } from './layups';
import { BASE_UNITS } from './indexRules';
import type { ResolveOptions } from './properties';
import type { Excluded, IndexResult, PropertyUse } from './types';

export interface UserIndex {
  readonly exponents: Readonly<Record<string, number>>;
  readonly derivationNote: string;
}

/** Base unit of a property in a user index: E in GPa, strengths in MPa, any other catalogue property in its canonical unit. */
const unitOf = (property: string): string | undefined => {
  const entry = catalogEntry(property);
  return entry === undefined ? undefined : property === 'E' ? BASE_UNITS.E : entry.strength ? BASE_UNITS.strength : entry.canonicalUnit;
};

/** First problem of a user index (note missing, no exponent, an unknown / density / zero-exponent property), or null; the code is SEL_DERIVATION_NOTE_MISSING for the note. */
export function userIndexProblem(index: UserIndex): { readonly code: string; readonly message: string } | null {
  if (index.derivationNote.trim() === '')
    return {
      code: 'SEL_DERIVATION_NOTE_MISSING',
      message: 'a user index needs a derivationNote: how P^a / rho follows from the loading case',
    };
  const entries = Object.entries(index.exponents);
  if (entries.length === 0) return { code: 'SEL_PARAMS_INVALID', message: 'a user index needs at least one exponent' };
  for (const [property, exponent] of entries) {
    if (property === 'density' || unitOf(property) === undefined)
      return {
        code: 'SEL_PARAMS_INVALID',
        message: `exponents.${property}: give a catalogue property other than density (rho is always the divisor)`,
      };
    if (!Number.isFinite(exponent) || exponent === 0)
      return { code: 'SEL_PARAMS_INVALID', message: `exponents.${property}: a finite, non-zero exponent` };
  }
  return null;
}

/** The unit string of the index, e.g. `GPa^(1/2)*MPa^(1/3)/(Mg/m^3)` (exponents as decimals). */
const userIndexUnit = (index: UserIndex): string =>
  `${Object.keys(index.exponents)
    .sort()
    .map((property) => `${unitOf(property) ?? ''}^(${index.exponents[property] ?? ''})`)
    .join('*')}/(${BASE_UNITS.density})`;

/**
 * prod(P_i ^ a_i) / rho of `material`; the same inputs rules as the rule-table indices (nothing imputed).
 * @failure a missing / ambiguous / out-of-range input -> Excluded with the code and the property names
 */
export function evaluateUserIndex(doc: CadDocument, material: string, index: UserIndex, options: IndexOptions): IndexResult | Excluded {
  const asked: ResolveOptions = { direction: options.direction, thickness: options.thickness, temperature: options.temperature };
  const properties = Object.keys(index.exponents).sort();
  const resolved = [
    ...properties.map((property) => ({ property, unit: unitOf(property) ?? '1' })),
    { property: 'density', unit: BASE_UNITS.density },
  ].map(({ property, unit }) => resolveCandidateProperty(doc, material, property, unit, asked, options.layup));
  const uses: PropertyUse[] = [];
  const failures = resolved.flatMap((entry) => {
    if (entry.ok) uses.push(entry.use);
    return entry.ok ? [] : [entry];
  });
  if (failures.length > 0)
    return {
      material,
      code: failures[0]?.code ?? 'SEL_PROPERTY_MISSING',
      reason: failures.map((failure) => failure.reason).join('; '),
      missing: failures.map((failure) => failure.property),
    };
  const density = uses.find((use) => use.property === 'density');
  const numerator = uses
    .filter((use) => use.property !== 'density')
    .reduce((product, use) => {
      const exponent = index.exponents[use.property];
      return exponent === undefined ? product : product * Math.pow(use.value, exponent);
    }, 1);
  const value = density === undefined ? Number.NaN : numerator / density.value;
  if (!Number.isFinite(value) || !(value > 0))
    return {
      material,
      code: 'SEL_PROPERTY_MISSING',
      reason: 'the index is not a positive finite number for these values',
      missing: properties,
    };
  return {
    material,
    case: 'user',
    value,
    unit: userIndexUnit(index),
    inputs: uses,
    unverified: uses.some((use) => use.unverified),
    unverifiedReasons: [...new Set(uses.flatMap((use) => use.unverifiedReasons.map((reason) => `${use.property}: ${reason}`)))],
    warnings: [...unverifiedWarning(material, uses), ...(options.layup === undefined ? [] : [anisotropicWarning(material, options.layup)])],
    provenance: { rule: 'user-defined index', derivation: index.derivationNote },
  };
}
