/** The performance-index rule table (PHY-12 TR-SEL-01, AF-30): data, one row per loading case, equal to validation/performance_indices.csv. */

import type { IndexCase } from './types';

export interface IndexRule {
  readonly case: IndexCase;
  readonly component: string;
  readonly property: 'E' | 'strength';
  /** n of P^n / rho, stored exactly as num / den. */
  readonly exponent: { readonly num: number; readonly den: number };
  readonly freeVariable: string;
  readonly fixed: string;
  readonly constraint: string;
  readonly index: string;
  readonly derivation: string;
  readonly source: string;
}

const SOURCE = 'Ashby, Performance Indices, ASM Handbook vol. 20 (R1, R2); re-derived: validation/performance_indices.csv';

const rule = (
  caseId: IndexCase,
  component: string,
  property: IndexRule['property'],
  den: number,
  num: number,
  freeVariable: string,
  fixed: string,
  constraint: string,
  index: string,
  derivation: string,
): IndexRule => ({
  case: caseId,
  component,
  property,
  exponent: { num, den },
  freeVariable,
  fixed,
  constraint,
  index,
  derivation,
  source: SOURCE,
});

export const INDEX_RULES: readonly IndexRule[] = [
  rule('tie_stiffness', 'tie (bar in tension)', 'E', 1, 1, 'area A', 'length L', 'stiffness S = E A / L', 'E/rho', 'm = rho L^2 S / E'),
  rule(
    'tie_strength',
    'tie (bar in tension)',
    'strength',
    1,
    1,
    'area A',
    'length L',
    'load F = sigma_f A',
    'sigma_f/rho',
    'm = rho L F / sigma_f',
  ),
  rule(
    'beam_stiffness',
    'beam in bending (square section)',
    'E',
    2,
    1,
    'section side b',
    'length L',
    'stiffness S = C E b^4 / (12 L^3)',
    'E^(1/2)/rho',
    'm = rho L b^2 with b ~ E^(-1/4)',
  ),
  rule(
    'beam_strength',
    'beam in bending (square section)',
    'strength',
    3,
    2,
    'section side b',
    'length L',
    'moment M = sigma_f b^3 / 6',
    'sigma_f^(2/3)/rho',
    'm = rho L b^2 with b ~ sigma_f^(-1/3)',
  ),
  rule(
    'panel_stiffness',
    'panel/plate in bending',
    'E',
    3,
    1,
    'thickness t',
    'length L and width w',
    'stiffness S = C E w t^3 / (12 L^3)',
    'E^(1/3)/rho',
    'm = rho w L t with t ~ E^(-1/3)',
  ),
  rule(
    'panel_strength',
    'panel/plate in bending',
    'strength',
    2,
    1,
    'thickness t',
    'length L and width w',
    'moment M = sigma_f w t^2 / 6',
    'sigma_f^(1/2)/rho',
    'm = rho w L t with t ~ sigma_f^(-1/2)',
  ),
  rule(
    'column_buckling',
    'slender column (square section)',
    'E',
    2,
    1,
    'section side b',
    'length L and end condition n',
    'Euler load F = n pi^2 E b^4 / (12 L^2)',
    'E^(1/2)/rho',
    'm = rho L b^2 with b ~ E^(-1/4)',
  ),
];

export const ruleOf = (indexCase: IndexCase): IndexRule | undefined => INDEX_RULES.find((entry) => entry.case === indexCase);

export const exponentValue = (entry: IndexRule): number => entry.exponent.num / entry.exponent.den;

/** Base units of an index (TR-SEL-03): E in GPa, strength in MPa, density in Mg/m^3. */
export const BASE_UNITS = { E: 'GPa', strength: 'MPa', density: 'Mg/m^3' } as const;

/** `GPa^(1/2)/(Mg/m^3)`, generated from the exponent. */
export function indexUnit(entry: IndexRule): string {
  const base = BASE_UNITS[entry.property];
  const power = entry.exponent.num === 1 && entry.exponent.den === 1 ? '' : `^(${entry.exponent.num}/${entry.exponent.den})`;
  return `${base}${power}/(${BASE_UNITS.density})`;
}
