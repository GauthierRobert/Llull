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
  /** Normal curvatures below this (1/unit) count as flat: a plane's reading is numerical noise, so the relative jump is 0. Default 1e-12; check_blends passes 1e-8 / diagonal. */
  readonly flatCurvature?: number;
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
  const flat = tolerances.flatCurvature ?? 1e-12;
  for (const sample of samples) {
    const [first, second] = sample.normalCurvature;
    const gap = Math.abs(first - second);
    const scale = Math.max(Math.abs(first), Math.abs(second));
    g0Gap = Math.max(g0Gap, sample.g0);
    g1AngleRad = Math.max(g1AngleRad, sample.g1);
    g2Gap = Math.max(g2Gap, gap);
    g2Rel = Math.max(g2Rel, scale < flat ? 0 : gap / scale);
  }
  const order: ContinuityOrder =
    g0Gap > tolerances.g0 ? 'none' : g1AngleRad > tolerances.g1AngleRad ? 'G0' : g2Rel > tolerances.g2Rel ? 'G1' : 'G2';
  return { g0Gap, g1AngleRad, g2Gap, g2Rel, order };
}

/** The two operands of a persistent name `e(<A>|<B>)` (split at the top-level bar), or null for any other name. */
export function splitEdgeName(name: string): readonly [string, string] | null {
  // a pair of faces that meets twice is told apart by a suffix: e(A|B)#2
  const base = name.replace(/#\d+$/, '');
  if (!base.startsWith('e(') || !base.endsWith(')')) return null;
  const inner = base.slice(2, -1);
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

/** The suffix of one sub-patch of an exact corner star: `blend(v:<edge name>,...)#k` (the plate patch of the fallback has none). */
export const STAR_SUFFIX = /#\d+$/;

/**
 * For a corner patch name `blend(v:<edge name>,<edge name>,...)`: the names of the edges that meet at the vertex (split at top-level commas);
 * null for any other name. The `#k` of a star sub-patch is ignored.
 */
export function cornerSources(faceName: string): readonly string[] | null {
  const base = faceName.replace(STAR_SUFFIX, '');
  if (!base.startsWith('blend(v:') || !base.endsWith(')')) return null;
  const inner = base.slice(8, -1);
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < inner.length; at++) {
    const char = inner[at];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(inner.slice(from, at));
      from = at + 1;
    }
  }
  parts.push(inner.slice(from));
  return parts;
}

/** Whether a recipe contains a `fillet`, `faceBlend`, `fullRound` or `blend` (blend_union joints) node. */
export function hasFillet(recipe: ShapeRecipe): boolean {
  switch (recipe.op) {
    case 'fillet':
      return true;
    case 'solid':
    case 'brep':
    case 'faceSlab':
    case 'sheetSolid':
      return false;
    case 'faceBlend':
    case 'fullRound':
    case 'blend':
      return true;
    case 'boolean':
      return hasFillet(recipe.a) || hasFillet(recipe.b);
    default:
      return hasFillet(recipe.source);
  }
}
