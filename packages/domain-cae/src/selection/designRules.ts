/** Design-rule ratios of a material substitution (PHY-12 TECHNICAL_SPEC §5.3): closed forms of the index rule table, rel 1e-9. */

import { exponentValue, ruleOf } from './indexRules';
import type { IndexCase } from './types';

export const DESIGN_RULES = [
  'same_geometry',
  'equal_stiffness_tie',
  'equal_stiffness_beam',
  'equal_stiffness_panel',
  'equal_strength_tie',
  'equal_strength_beam',
  'equal_strength_panel',
] as const;

export type DesignRule = (typeof DESIGN_RULES)[number];

/** Material values of one side of a substitution, in base units (rho Mg/m^3, E GPa, strength MPa). */
export interface Side {
  readonly rho: number;
  readonly e?: number;
  readonly strength?: number;
}

interface Resize {
  readonly index: IndexCase;
  readonly dimension: string;
  /** Exponent of (P1 / P2) in the new size: b ~ P^(-1/4) for a beam in stiffness, ... */
  readonly sizeExponent: number;
}

const RESIZE: Readonly<Record<Exclude<DesignRule, 'same_geometry'>, Resize>> = {
  equal_stiffness_tie: { index: 'tie_stiffness', dimension: 'section area A', sizeExponent: 1 },
  equal_stiffness_beam: { index: 'beam_stiffness', dimension: 'section side b', sizeExponent: 1 / 4 },
  equal_stiffness_panel: { index: 'panel_stiffness', dimension: 'thickness t', sizeExponent: 1 / 3 },
  equal_strength_tie: { index: 'tie_strength', dimension: 'section area A', sizeExponent: 1 },
  equal_strength_beam: { index: 'beam_strength', dimension: 'section side b', sizeExponent: 1 / 3 },
  equal_strength_panel: { index: 'panel_strength', dimension: 'thickness t', sizeExponent: 1 / 2 },
};

export const isStrengthRule = (rule: DesignRule): boolean => rule.startsWith('equal_strength');

export interface RuleRatios {
  readonly massRatio: number;
  readonly resized?: { readonly dimension: string; readonly factor: number };
  readonly stiffness?: {
    readonly ratio: number;
    readonly deflectionRatio: number;
    readonly modalFrequencyRatio?: number;
    readonly bucklingFactorRatio?: number;
  };
}

/**
 * Ratios 2 / 1 of a swap. same_geometry: mass rho2 / rho1, stiffness E2 / E1, deflection E1 / E2, modal frequency sqrt((E2/rho2) / (E1/rho1)), buckling factor E2 / E1.
 * An equal_* rule re-sizes the idealised part of its case: mass (rho2 / rho1) (P1 / P2)^n with n of the index rule and P = E or the strength; stiffness unchanged for the stiffness rules.
 * @failure an equal_* rule without the E / strength it needs -> null (callers refuse with SEL_PROPERTY_MISSING first); same_geometry without E gives mass only
 */
export function ratiosOf(rule: DesignRule, from: Side, to: Side): RuleRatios | null {
  if (rule === 'same_geometry') {
    const massRatio = to.rho / from.rho;
    if (from.e === undefined || to.e === undefined) return { massRatio };
    const ratio = to.e / from.e;
    return {
      massRatio,
      stiffness: {
        ratio,
        deflectionRatio: from.e / to.e,
        modalFrequencyRatio: Math.sqrt(to.e / to.rho / (from.e / from.rho)),
        bucklingFactorRatio: ratio,
      },
    };
  }
  const resize = RESIZE[rule];
  const indexRule = ruleOf(resize.index);
  const strength = isStrengthRule(rule);
  const first = strength ? from.strength : from.e;
  const second = strength ? to.strength : to.e;
  if (indexRule === undefined || first === undefined || second === undefined) return null;
  const quotient = first / second;
  return {
    massRatio: (to.rho / from.rho) * Math.pow(quotient, exponentValue(indexRule)),
    resized: { dimension: resize.dimension, factor: Math.pow(quotient, resize.sizeExponent) },
    ...(strength ? {} : { stiffness: { ratio: 1, deflectionRatio: 1 } }),
  };
}
