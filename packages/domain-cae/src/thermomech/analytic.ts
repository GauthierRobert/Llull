/**
 * Closed-form thermal-stress solutions (PHY-04 §5.5): the functions of docs/physics/04-thermo-mechanical/validation/
 * generate_thermomech_reference.py, same algebra and operation order. SI-consistent inputs (MPa, mm, 1/K, K).
 */

/** Uniaxial, biaxial and triaxial fully restrained thermal stress [S9]. */
export function restrained(E: number, alpha: number, dT: number, nu: number): { uniaxial: number; biaxial: number; triaxial: number } {
  return { uniaxial: -E * alpha * dT, biaxial: (-E * alpha * dT) / (1 - nu), triaxial: (-E * alpha * dT) / (1 - 2 * nu) };
}

/** Hot circular inclusion, same E and nu, infinite plate, plane stress: stresses inside and at radius r >= a outside. */
export function inclusion(
  E: number,
  alpha: number,
  dT: number,
  a: number,
  r: number,
): { insideRadial: number; insideHoop: number; outsideRadial: number; outsideHoop: number } {
  const eadt = E * alpha * dT;
  return {
    insideRadial: -eadt / 2,
    insideHoop: -eadt / 2,
    outsideRadial: (-eadt * a * a) / (2 * r * r),
    outsideHoop: (eadt * a * a) / (2 * r * r),
  };
}

export interface BimetalInput {
  readonly t1: number;
  readonly t2: number;
  readonly E1: number;
  readonly E2: number;
  readonly alpha1: number;
  readonly alpha2: number;
  readonly dT: number;
}

/** Timoshenko (1925) curvature of a bimetal strip, 1/length. */
export function bimetalTimoshenko({ t1, t2, E1, E2, alpha1, alpha2, dT }: BimetalInput): number {
  const m = t1 / t2;
  const n = E1 / E2;
  const h = t1 + t2;
  return (6 * (alpha2 - alpha1) * dT * (1 + m) ** 2) / (h * (3 * (1 + m) ** 2 + (1 + m * n) * (m * m + 1 / (m * n))));
}

/** Curvature from axial-force and moment equilibrium of the two layers (independent cross-check of the Timoshenko closed form). */
export function bimetalEquilibrium({ t1, t2, E1, E2, alpha1, alpha2, dT }: BimetalInput): number {
  const A1 = E1 * t1;
  const A2 = E2 * t2;
  const S1 = (E1 * t1 * t1) / 2;
  const S2 = (-E2 * t2 * t2) / 2;
  const I1 = (E1 * t1 ** 3) / 3;
  const I2 = (E2 * t2 ** 3) / 3;
  const a11 = A1 + A2;
  const a12 = S1 + S2;
  const b1 = (A1 * alpha1 + A2 * alpha2) * dT;
  const a21 = S1 + S2;
  const a22 = I1 + I2;
  const b2 = (S1 * alpha1 + S2 * alpha2) * dT;
  const det = a11 * a22 - a12 * a21;
  return -((a11 * b2 - a21 * b1) / det);
}

export interface ThickCylinderInput {
  readonly E: number;
  readonly nu: number;
  readonly alpha: number;
  readonly a: number;
  readonly b: number;
  /** Bore minus outer-surface temperature (K); T(r) = dT ln(b/r) / ln(b/a). */
  readonly dT: number;
}

export interface ThickCylinderStress {
  readonly temperature: number;
  readonly sigmaRadial: number;
  readonly sigmaHoop: number;
  readonly sigmaAxial: number;
  /** Hoop stress from Simpson quadrature of the integral form (cross-check). */
  readonly sigmaHoopQuadrature: number;
  /** Hoop stress from the Timoshenko & Goodier explicit log form (cross-check). */
  readonly sigmaHoopClassic: number;
}

function simpson(f: (x: number) => number, a: number, b: number, n = 2000): number {
  const h = (b - a) / n;
  let sum = f(a) + f(b);
  for (let i = 1; i < n; i += 1) sum += (i % 2 === 1 ? 4 : 2) * f(a + i * h);
  return (sum * h) / 3;
}

/** Steady logarithmic radial gradient, free ends (Timoshenko & Goodier): closed integral form, quadrature and log form. */
export function thickCylinder({ E, nu, alpha, a, b, dT }: ThickCylinderInput, r: number): ThickCylinderStress {
  const L = Math.log(b / a);
  const T = (x: number): number => (dT * Math.log(b / x)) / L;
  const I = (x: number): number => (dT / L) * ((x * x * Math.log(b / x)) / 2 + (x * x) / 4 - (a * a * Math.log(b / a)) / 2 - (a * a) / 4);
  const c = (E * alpha) / (1 - nu);
  const Ib = I(b);
  const hoop = (c / (r * r)) * (((r * r + a * a) / (b * b - a * a)) * Ib + I(r) - T(r) * r * r);
  const radial = (c / (r * r)) * (((r * r - a * a) / (b * b - a * a)) * Ib - I(r));
  const axial = c * ((2 * Ib) / (b * b - a * a) - T(r));
  const Iq = r > a ? simpson((x) => T(x) * x, a, r) : 0;
  const quadrature = (c / (r * r)) * (((r * r + a * a) / (b * b - a * a)) * simpson((x) => T(x) * x, a, b) + Iq - T(r) * r * r);
  const k = (E * alpha * dT) / (2 * (1 - nu) * L);
  const q = (a * a) / (b * b - a * a);
  const classic = k * (1 - Math.log(b / r) - q * (1 + (b * b) / (r * r)) * L);
  return {
    temperature: T(r),
    sigmaRadial: radial,
    sigmaHoop: hoop,
    sigmaAxial: axial,
    sigmaHoopQuadrature: quadrature,
    sigmaHoopClassic: classic,
  };
}

/** Free-bending response to a linear through-thickness temperature difference: curvature, simply supported mid-span bow, cantilever tip. */
export function gradientBeam(
  alpha: number,
  dT: number,
  h: number,
  L: number,
): { curvature: number; midspanBow: number; cantileverTip: number } {
  const curvature = (alpha * dT) / h;
  return { curvature, midspanBow: (curvature * L ** 2) / 8, cantileverTip: (curvature * L ** 2) / 2 };
}

export interface ShrinkFitInput {
  /** Shaft (solid) radius b and hub outer radius c, same length unit. */
  readonly b: number;
  readonly c: number;
  readonly hubE: number;
  readonly hubNu: number;
  readonly shaftE: number;
  readonly shaftNu: number;
}

/** Lame contact pressure of a solid shaft in a hub for a radial interference d_r; hoop stress at the hub bore equals p (c^2 + b^2)/(c^2 - b^2). */
export function shrinkFitPressure(radialInterference: number, { b, c, hubE, hubNu, shaftE, shaftNu }: ShrinkFitInput): number {
  return radialInterference / (b * (((c * c + b * b) / (c * c - b * b) + hubNu) / hubE + (1 - shaftNu) / shaftE));
}

export const hubBoreHoopStress = (pressure: number, b: number, c: number): number => (pressure * (c * c + b * b)) / (c * c - b * b);
