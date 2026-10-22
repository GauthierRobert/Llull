/**
 * Pure helpers of `check_blends` (BLD M0, TECHNICAL_SPEC §5.9, §5.10): the continuity order of a blend contact from the kernel's
 * `edgeContinuity` samples, persistent blend / edge name parsing, and the recipe walk that finds fillets.
 * @invariant no kernel, no document; numbers in document units (curvature in 1/unit, angles in radians)
 */

import type { ShapeRecipe } from '../../model/types';

export interface ContactSample {
  readonly t: number;
  readonly g0: number;
  readonly g1: number;
  readonly normalCurvature: readonly [number, number];
}

type ContinuityOrder = 'none' | 'G0' | 'G1' | 'G2';

export interface ContactTolerances {
  /** Largest gap between the faces before the contact counts as open (document units). */
  readonly g0: number;
  readonly g1AngleRad: number;
  readonly g2Rel: number;
}

export interface ContactMeasure {
  /** Largest gap between the two faces along the contact (document units). */
  readonly g0Gap: number;
  /** Largest angle between the two outward normals (radians). */
  readonly g1AngleRad: number;
  /** Largest jump of the normal curvature across the contact, 1/unit. */
  readonly g2Gap: number;
  /** Largest relative jump |k1 - k2| / max(|k1|, |k2|): 0 when both vanish, 1 for a plane against a cylinder. */
  readonly g2Rel: number;
  /** Highest order reached: none when the faces are farther apart than the gap tolerance, G0 when the normals differ by more than the angle tolerance, G1 when the curvature jumps, else G2. */
  readonly order: ContinuityOrder;
}

/** @failure no samples -> null */
export function measureContact(samples: readonly ContactSample[], tolerances: ContactTolerances): ContactMeasure | null {
  if (samples.length === 0) return null;
  let g0Gap = 0;
  let g1AngleRad = 0;
  let g2Gap = 0;
  let g2Rel = 0;
  for (const sample of samples) {
    const [first, second] = sample.normalCurvature;
    const gap = Math.abs(first - second);
    const scale = Math.max(Math.abs(first), Math.abs(second));
    g0Gap = Math.max(g0Gap, sample.g0);
    g1AngleRad = Math.max(g1AngleRad, sample.g1);
    g2Gap = Math.max(g2Gap, gap);
    g2Rel = Math.max(g2Rel, scale < 1e-12 ? 0 : gap / scale);
  }
  const order: ContinuityOrder =
    g0Gap > tolerances.g0 ? 'none' : g1AngleRad > tolerances.g1AngleRad ? 'G0' : g2Rel > tolerances.g2Rel ? 'G1' : 'G2';
  return { g0Gap, g1AngleRad, g2Gap, g2Rel, order };
}

/** The two operands of a persistent name `e(<A>|<B>)` (split at the top-level bar), or null for any other name. */
export function splitEdgeName(name: string): readonly [string, string] | null {
  if (!name.startsWith('e(') || !name.endsWith(')')) return null;
  const inner = name.slice(2, -1);
  let depth = 0;
  for (let at = 0; at < inner.length; at++) {
    const char = inner[at];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === '|' && depth === 0) return [inner.slice(0, at), inner.slice(at + 1)];
  }
  return null;
}

/** For a blend face name `blend(<edge name>)`: the source edge name and the names of the two support faces; null for any other name. */
export function blendSource(faceName: string): { readonly edge: string; readonly supports: readonly [string, string] } | null {
  if (!faceName.startsWith('blend(') || !faceName.endsWith(')')) return null;
  const edge = faceName.slice(6, -1);
  const supports = splitEdgeName(edge);
  return supports === null ? null : { edge, supports };
}

/** Whether a recipe contains a `fillet` node. */
export function hasFillet(recipe: ShapeRecipe): boolean {
  switch (recipe.op) {
    case 'fillet':
      return true;
    case 'solid':
    case 'brep':
    case 'faceSlab':
      return false;
    case 'boolean':
      return hasFillet(recipe.a) || hasFillet(recipe.b);
    case 'blend':
      return recipe.sources.some(hasFillet);
    default:
      return hasFillet(recipe.source);
  }
}
