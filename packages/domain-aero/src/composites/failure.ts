/** First-ply failure criteria (06 CMP §5.3): strength ratio R = load multiplier that brings a ply point to failure (Infinity: never). */

import type { LaminaMaterial } from '@core/model/composites';
import type { Triple } from './clt';

export type Criterion = 'max_stress' | 'tsai_hill' | 'tsai_wu';

export const CRITERIA: readonly Criterion[] = ['max_stress', 'tsai_hill', 'tsai_wu'];

/** Default Tsai-Wu interaction factor F12* when no biaxial data exists (common convention). */
export const DEFAULT_F12_STAR = -0.5;

export interface Strengths {
  readonly Xt: number;
  readonly Xc: number;
  readonly Yt: number;
  readonly Yc: number;
  readonly S: number;
}

/** The five strengths of `material`, or the names of the missing ones. */
export function strengthsOf(material: LaminaMaterial): Strengths | { readonly missing: readonly string[] } {
  const { Xt, Xc, Yt, Yc, S } = material;
  const missing = (['Xt', 'Xc', 'Yt', 'Yc', 'S'] as const).filter((name) => material[name] === undefined);
  return missing.length > 0 || Xt === undefined || Xc === undefined || Yt === undefined || Yc === undefined || S === undefined
    ? { missing }
    : { Xt, Xc, Yt, Yc, S };
}

export interface PlyRatio {
  readonly R: number;
  /** Max stress only: which stress governs. */
  readonly mode?: 'fibre' | 'matrix' | 'shear';
}

/** Strength ratio of the stress state [s1, s2, t12] (MPa, material axes). */
export function strengthRatio(
  criterion: Criterion,
  [s1, s2, t12]: Triple,
  { Xt, Xc, Yt, Yc, S }: Strengths,
  f12Star: number = DEFAULT_F12_STAR,
): PlyRatio {
  if (criterion === 'max_stress') {
    const candidates: [number, 'fibre' | 'matrix' | 'shear'][] = [
      [s1 === 0 ? Infinity : (s1 > 0 ? Xt : Xc) / Math.abs(s1), 'fibre'],
      [s2 === 0 ? Infinity : (s2 > 0 ? Yt : Yc) / Math.abs(s2), 'matrix'],
      [t12 === 0 ? Infinity : S / Math.abs(t12), 'shear'],
    ];
    const [R, mode] = candidates.reduce((best, next) => (next[0] < best[0] ? next : best));
    return Number.isFinite(R) ? { R, mode } : { R };
  }
  if (criterion === 'tsai_hill') {
    const X = s1 >= 0 ? Xt : Xc;
    const Y = s2 >= 0 ? Yt : Yc;
    const index = (s1 / X) ** 2 - (s1 * s2) / X ** 2 + (s2 / Y) ** 2 + (t12 / S) ** 2;
    return { R: index > 0 ? 1 / Math.sqrt(index) : Infinity };
  }
  const F1 = 1 / Xt - 1 / Xc;
  const F2 = 1 / Yt - 1 / Yc;
  const F11 = 1 / (Xt * Xc);
  const F22 = 1 / (Yt * Yc);
  const F12 = f12Star * Math.sqrt(F11 * F22);
  const a = F11 * s1 * s1 + F22 * s2 * s2 + (t12 * t12) / (S * S) + 2 * F12 * s1 * s2;
  const b = F1 * s1 + F2 * s2;
  const root = b * b + 4 * a;
  const denominator = b + Math.sqrt(Math.max(root, 0));
  return { R: denominator > 0 ? 2 / denominator : Infinity };
}
