/** 14 FLL-M3 printed-part homogenisation: skin fraction of a closed triangle mesh, the orthotropic constants, the power-law fit of the infill exponent. */

import type { PrintIdealization } from '@core/model/printIdealization';
import type { Vec3 } from '@core/model/vectors';

type Triangle = readonly [Vec3, Vec3, Vec3];

export interface SkinEstimate {
  /** Enclosed volume, document units cubed. */
  readonly volume: number;
  /** First-order skin volume (walls + top / bottom layers) as a fraction of `volume`, in [0, 1]. */
  readonly fraction: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Skin fraction of the solid bounded by `triangles`: the skin volume per unit area of a face at angle theta to `axis` is
 * `wall |sin theta| + topBottom |cos theta|` (exact for faces parallel / perpendicular to the build direction), summed over the faces, capped at the volume.
 * @invariant first order in the skin thickness: corners and edges are counted twice, so a thick skin over-estimates (the cap makes a fully solid part fraction 1)
 * @failure no triangles, or a zero / non-finite enclosed volume -> null
 */
export function skinEstimate(triangles: readonly Triangle[], axis: Vec3, wall: number, topBottom: number): SkinEstimate | null {
  let signed = 0;
  let skin = 0;
  for (const [a, b, c] of triangles) {
    const normal = cross(sub(b, a), sub(c, a));
    const twiceArea = Math.hypot(...normal);
    signed += dot(a, cross(b, c)) / 6;
    if (twiceArea === 0) continue;
    const along = Math.min(1, Math.abs(dot(normal, axis)) / twiceArea);
    skin += (twiceArea / 2) * (wall * Math.sqrt(1 - along * along) + topBottom * along);
  }
  const volume = Math.abs(signed);
  if (!(volume > 0) || !Number.isFinite(volume) || !Number.isFinite(skin)) return null;
  return { volume, fraction: Math.min(1, skin / volume) };
}

export interface HomogenisedPart {
  /** MPa; directions 1 and 2 lie in the build plane, 3 is the build direction. */
  readonly E1: number;
  readonly E2: number;
  readonly E3: number;
  readonly nu12: number;
  readonly nu13: number;
  readonly nu23: number;
  readonly G12: number;
  readonly G13: number;
  readonly G23: number;
  /** Effective density over the solid density: skin + infill density x core. */
  readonly densityRatio: number;
  /** Core stiffness over solid stiffness at the infill density: density^m. */
  readonly coreFactor: number;
}

/** True when the orthotropic compliance of `part` is positive definite (the engineering-constant stability conditions). */
export function isStable(part: HomogenisedPart): boolean {
  const { E1, E2, E3, nu12, nu13, nu23, G12, G13, G23 } = part;
  const nu21 = (nu12 * E2) / E1;
  const nu32 = (nu23 * E3) / E2;
  const nu31 = (nu13 * E3) / E1;
  const positive = [E1, E2, E3, G12, G13, G23].every((value) => value > 0 && Number.isFinite(value));
  return (
    positive &&
    1 - nu12 * nu21 > 0 &&
    1 - nu23 * nu32 > 0 &&
    1 - nu13 * nu31 > 0 &&
    1 - nu12 * nu21 - nu23 * nu32 - nu31 * nu13 - 2 * nu21 * nu32 * nu13 > 0
  );
}

/**
 * Effective orthotropic constants: modulus per direction = coupon modulus x (skin + (1 - skin) x density^m) (parallel load paths), Poisson's ratio `nu` of the solid material in every
 * plane, shear G12 = E_xy / (2 (1 + nu)) and G13 = G23 = E_z / (2 (1 + nu)) (not measured: flagged by the caller). Infill density 1 or skin fraction 1 gives the solid coupon moduli exactly.
 */
export function homogenise(print: PrintIdealization, nu: number, skinFraction: number): HomogenisedPart {
  const coreFactor = print.infill.density ** print.exponent.value;
  const factor = skinFraction + (1 - skinFraction) * coreFactor;
  const E_xy = print.coupon.E_xyMpa * factor;
  const E_z = print.coupon.E_zMpa * factor;
  return {
    E1: E_xy,
    E2: E_xy,
    E3: E_z,
    nu12: nu,
    nu13: nu,
    nu23: nu,
    G12: E_xy / (2 * (1 + nu)),
    G13: E_z / (2 * (1 + nu)),
    G23: E_z / (2 * (1 + nu)),
    densityRatio: skinFraction + (1 - skinFraction) * print.infill.density,
    coreFactor,
  };
}

export interface PowerFit {
  /** Exponent m of E = C density^m. */
  readonly m: number;
  /** E at density 1 (MPa), the same unit as the data. */
  readonly C: number;
  readonly points: number;
  /** RMS of ln E - ln(C density^m). */
  readonly rmsLogResidual: number;
  /** Largest |E_fit / E - 1|. */
  readonly maxRelativeResidual: number;
  /** 1 - SSE / SST on ln E (1 when all the data share one value). */
  readonly rSquared: number;
}

/**
 * Least squares of ln E = ln C + m ln density.
 * @failure fewer than 2 points, fewer than 2 distinct densities, a density outside (0, 1] or a modulus <= 0 -> a reason string
 */
export function fitPowerLaw(points: readonly { readonly density: number; readonly modulus: number }[]): PowerFit | string {
  if (points.length < 2) return `a fit needs at least 2 coupons, got ${points.length}`;
  if (points.some((p) => !(p.density > 0 && p.density <= 1) || !(p.modulus > 0) || !Number.isFinite(p.modulus)))
    return 'every coupon needs an infill density in (0, 1] and a modulus > 0';
  const x = points.map((p) => Math.log(p.density));
  const y = points.map((p) => Math.log(p.modulus));
  const n = points.length;
  const meanX = x.reduce((sum, v) => sum + v, 0) / n;
  const meanY = y.reduce((sum, v) => sum + v, 0) / n;
  const sxx = x.reduce((sum, v) => sum + (v - meanX) ** 2, 0);
  if (!(sxx > 1e-24)) return 'the coupons need at least 2 distinct infill densities';
  const sxy = x.reduce((sum, v, i) => sum + (v - meanX) * ((y[i] ?? 0) - meanY), 0);
  const m = sxy / sxx;
  const a = meanY - m * meanX;
  const residuals = y.map((value, i) => value - (a + m * (x[i] ?? 0)));
  const sse = residuals.reduce((sum, r) => sum + r * r, 0);
  const sst = y.reduce((sum, v) => sum + (v - meanY) ** 2, 0);
  return {
    m,
    C: Math.exp(a),
    points: n,
    rmsLogResidual: Math.sqrt(sse / n),
    maxRelativeResidual: Math.max(...residuals.map((r) => Math.abs(Math.exp(-r) - 1))),
    rSquared: sst > 0 ? 1 - sse / sst : 1,
  };
}
