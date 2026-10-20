/**
 * LaRC03-type plane-stress failure criterion (06 CMP M6): fibre tension by maximum strain, matrix tension with the fracture-toughness
 * ratio, matrix compression on a searched fracture plane (alpha0 = 53 degrees), fibre compression by kinking with the initial misalignment.
 * Dávila, Camanho, Rose, NASA/TM-2003-212663 (2003). In-situ strengths (thin-ply effect) are NOT applied.
 */

import type { LaminaMaterial } from '@core/model/composites';
import type { Triple } from './clt';
import { strengthsOf } from './failure';

export type Larc03Mode = 'FT' | 'FC' | 'MT' | 'MC';

const ALPHA0 = (53 * Math.PI) / 180;

interface Constants {
  readonly Xt: number;
  readonly Xc: number;
  readonly Yt: number;
  readonly Yc: number;
  readonly S: number;
  readonly E1: number;
  readonly G12: number;
  readonly nu12: number;
  readonly g: number;
  readonly muT: number;
  readonly muL: number;
  readonly ST: number;
  readonly phi0: number;
}

/** The material constants of the criterion, or the names of the missing inputs. */
export function larc03Constants(material: LaminaMaterial): Constants | { readonly missing: readonly string[] } {
  const strengths = strengthsOf(material);
  const missing = [
    ...('missing' in strengths ? strengths.missing : []),
    ...(material.GIc === undefined ? ['GIc'] : []),
    ...(material.GIIc === undefined ? ['GIIc'] : []),
  ];
  if ('missing' in strengths || material.GIc === undefined || material.GIIc === undefined) return { missing };
  const { Xc, Yc, S } = strengths;
  const muT = -1 / Math.tan(2 * ALPHA0);
  const muL = (-S * Math.cos(2 * ALPHA0)) / (Yc * Math.cos(ALPHA0) ** 2);
  const ST = Yc * Math.cos(ALPHA0) * (Math.sin(ALPHA0) + Math.cos(ALPHA0) / Math.tan(2 * ALPHA0));
  const q = S / Xc + muL;
  const phi0 = Math.atan((1 - Math.sqrt(1 - 4 * q * (S / Xc))) / (2 * q));
  return { ...strengths, E1: material.E1, G12: material.G12, nu12: material.nu12, g: material.GIc / material.GIIc, muT, muL, ST, phi0 };
}

const matrixTension = (c: Constants, s2: number, t: number): number => (1 - c.g) * (s2 / c.Yt) + c.g * (s2 / c.Yt) ** 2 + (t / c.S) ** 2;

/** Failure index of each mode (0 when the mode does not apply to the stress state). */
function indices(c: Constants, [s1, s2, t12]: Triple): Record<Larc03Mode, number> {
  const out: Record<Larc03Mode, number> = { FT: 0, FC: 0, MT: 0, MC: 0 };
  if (s1 > 0) out.FT = (s1 - c.nu12 * s2) / c.Xt;
  if (s2 >= 0) out.MT = matrixTension(c, s2, t12);
  if (s2 < 0) {
    let worst = 0;
    for (let degrees = 1; degrees <= 90; degrees += 0.5) {
      const alpha = (degrees * Math.PI) / 180;
      const sigmaN = s2 * Math.cos(alpha) ** 2;
      const tauT = Math.abs(s2) * Math.sin(alpha) * Math.cos(alpha);
      const tauL = Math.abs(t12) * Math.cos(alpha);
      const index = (tauT / (c.ST - c.muT * sigmaN)) ** 2 + (tauL / (c.S - c.muL * sigmaN)) ** 2;
      worst = Math.max(worst, index);
    }
    out.MC = worst;
  }
  if (s1 < 0) {
    const denominator = c.G12 + s1 - s2;
    if (denominator <= 0) out.FC = Infinity;
    else {
      const phi = (Math.abs(t12) + (c.G12 - c.Xc) * c.phi0) / denominator;
      const [sin, cos] = [Math.sin(phi), Math.cos(phi)];
      const s2m = s1 * sin * sin + s2 * cos * cos - 2 * Math.abs(t12) * sin * cos;
      const tm = Math.abs((s2 - s1) * sin * cos + Math.abs(t12) * (cos * cos - sin * sin));
      out.FC = s2m < 0 ? (tm + c.muL * s2m) / c.S : matrixTension(c, s2m, tm);
    }
  }
  return out;
}

const worstOf = (values: Record<Larc03Mode, number>): { index: number; mode: Larc03Mode } =>
  (['FT', 'FC', 'MT', 'MC'] as const).reduce((best, mode) => (values[mode] > best.index ? { index: values[mode], mode } : best), {
    index: 0,
    mode: 'FT' as Larc03Mode,
  });

/**
 * Strength ratio R: the load multiplier at which the governing LaRC03 index reaches 1 (bisection on the stress scale).
 * @invariant Infinity when no index reaches 1 up to a 1e9 multiplier (a stress state with no load)
 */
export function larc03Ratio(constants: Constants, stress: Triple): { readonly R: number; readonly mode: Larc03Mode } {
  const at = (scale: number): { index: number; mode: Larc03Mode } =>
    worstOf(indices(constants, [stress[0] * scale, stress[1] * scale, stress[2] * scale]));
  let upper = 1;
  while (at(upper).index < 1 && upper < 1e9) upper *= 2;
  if (at(upper).index < 1) return { R: Infinity, mode: 'FT' };
  let lower = upper > 1 ? upper / 2 : 0;
  for (let i = 0; i < 80; i++) {
    const mid = (lower + upper) / 2;
    if (at(mid).index >= 1) upper = mid;
    else lower = mid;
  }
  return { R: upper, mode: at(upper).mode };
}
