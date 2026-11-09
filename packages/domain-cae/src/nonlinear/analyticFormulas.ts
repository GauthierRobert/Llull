/** Closed forms of nonlinear_analytic_check (PHY-05 TR §5.6), identical to docs/physics/05-nonlinear-structural/validation/generate_nls_reference.py. */

/** Gauss-Legendre nodes and weights of order `order` (Newton on P_n), as the generator computes them. */
function gaussLegendre(order: number): readonly (readonly [number, number])[] {
  const points: (readonly [number, number])[] = [];
  for (let i = 1; i <= order; i++) {
    let x = Math.cos((Math.PI * (i - 0.25)) / (order + 0.5));
    let derivative = 1;
    for (let iteration = 0; iteration < 100; iteration++) {
      let p0 = 1;
      let p1 = x;
      for (let k = 2; k <= order; k++) [p0, p1] = [p1, ((2 * k - 1) * x * p1 - (k - 1) * p0) / k];
      derivative = (order * (x * p1 - p0)) / (x * x - 1);
      const step = p1 / derivative;
      x -= step;
      if (Math.abs(step) < 1e-16) break;
    }
    points.push([x, 2 / ((1 - x * x) * derivative * derivative)]);
  }
  return points;
}

const GAUSS = gaussLegendre(24);

/** Composite Gauss-Legendre integral of `f` over [a, b] with 64 panels. */
function integrate(f: (t: number) => number, a: number, b: number): number {
  const panels = 64;
  const h = (b - a) / panels;
  let sum = 0;
  for (let panel = 0; panel < panels; panel++) {
    const middle = a + (panel + 0.5) * h;
    for (const [x, weight] of GAUSS) sum += weight * f(middle + 0.5 * h * x);
  }
  return sum * 0.5 * h;
}

const incompleteF = (phi: number, k: number): number => integrate((t) => 1 / Math.sqrt(1 - (k * Math.sin(t)) ** 2), 0, phi);
const incompleteE = (phi: number, k: number): number => integrate((t) => Math.sqrt(1 - (k * Math.sin(t)) ** 2), 0, phi);

export interface Elastica {
  readonly lambda: number;
  readonly tipSlopeRad: number;
  readonly deltaVOverL: number;
  readonly deltaHOverL: number;
  readonly linearDeltaVOverL: number;
}

/** (lambda = P L^2 / EI, delta_v / L, delta_h / L) of the elastica cantilever with tip slope `theta0` (Bisshopp-Drucker form). */
function elasticaFromTipSlope(theta0: number): readonly [number, number, number] {
  const k = Math.sqrt((1 + Math.sin(theta0)) / 2);
  const phi1 = Math.asin(1 / (k * Math.SQRT2));
  const alphaL = incompleteF(Math.PI / 2, k) - incompleteF(phi1, k);
  const deltaV = 1 - (2 * (incompleteE(Math.PI / 2, k) - incompleteE(phi1, k))) / alphaL;
  const xTip = Math.sqrt(2 * Math.sin(theta0)) / alphaL;
  return [alphaL * alphaL, deltaV, 1 - xTip];
}

/** Elastica cantilever (inextensible, constant EI, vertical end load of fixed direction) at load parameter `lambda` = P L^2 / EI > 0. */
export function elastica(lambda: number): Elastica {
  let low = 1e-9;
  let high = Math.PI / 2 - 1e-12;
  for (let iteration = 0; iteration < 200; iteration++) {
    const middle = 0.5 * (low + high);
    if ((elasticaFromTipSlope(middle)[0] ?? 0) < lambda) low = middle;
    else high = middle;
  }
  const tipSlopeRad = 0.5 * (low + high);
  const [, deltaVOverL, deltaHOverL] = elasticaFromTipSlope(tipSlopeRad);
  return { lambda, tipSlopeRad, deltaVOverL, deltaHOverL, linearDeltaVOverL: lambda / 3 };
}

export const SUPPORTS = ['cantilever', 'simply_supported', 'propped_cantilever', 'fixed_fixed'] as const;
export type Support = (typeof SUPPORTS)[number];

/** Collapse load factor c of P_c = c M_p / L (virtual work: tip load of a cantilever, central load of the others). */
const COLLAPSE_FACTOR: Readonly<Record<Support, number>> = { cantilever: 1, simply_supported: 4, propped_cantilever: 6, fixed_fixed: 8 };

export interface HingeResult {
  readonly plasticMomentNmm: number;
  readonly yieldMomentNmm: number;
  readonly shapeFactor: number;
  readonly collapseLoadN: number;
}

/** Rectangle b x h, yield stress sigmaY: M_p = sigmaY b h^2 / 4, M_y = sigmaY b h^2 / 6, collapse load of `support` over span L. */
export function plasticHinge(support: Support, b: number, h: number, sigmaY: number, length: number): HingeResult {
  const plastic = (sigmaY * b * h * h) / 4;
  return {
    plasticMomentNmm: plastic,
    yieldMomentNmm: (sigmaY * b * h * h) / 6,
    shapeFactor: 1.5,
    collapseLoadN: (COLLAPSE_FACTOR[support] * plastic) / length,
  };
}

/** M / M_y of an elastic-perfectly plastic rectangle at curvature ratio `kappaOverKappaY` = kappa / kappa_y. */
export const momentRatio = (kappaOverKappaY: number): number =>
  kappaOverKappaY <= 1 ? kappaOverKappaY : 1.5 * (1 - 1 / (kappaOverKappaY * kappaOverKappaY) / 3);

export interface CylinderResult {
  readonly trescaFirstYieldMPa: number;
  readonly trescaCollapseMPa: number;
  readonly misesFirstYieldMPa: number;
  readonly misesCollapseMPa: number;
}

/** Internal pressure of a thick cylinder a < b, elastic-perfectly plastic: Tresca and von Mises first yield and collapse (see §5.6). */
export function thickCylinder(a: number, b: number, sigmaY: number, nu: number): CylinderResult {
  const q = (a * a) / (b * b - a * a);
  const radial = -1;
  const hoop = q * ((b * b) / (a * a) + 1);
  const axial = nu * (radial + hoop);
  const vonMises = Math.sqrt(0.5 * ((radial - hoop) ** 2 + (hoop - axial) ** 2 + (axial - radial) ** 2));
  return {
    trescaFirstYieldMPa: (sigmaY / 2) * (1 - (a * a) / (b * b)),
    trescaCollapseMPa: sigmaY * Math.log(b / a),
    misesFirstYieldMPa: sigmaY / vonMises,
    misesCollapseMPa: (2 / Math.sqrt(3)) * sigmaY * Math.log(b / a),
  };
}

/** Boundary pressure with the plastic zone a <= r <= c: p = k (1 - c^2/b^2 + 2 ln(c/a)); Tresca k = sigmaY/2, incompressible von Mises k = sigmaY/sqrt3. */
export const pressureAtPlasticRadius = (a: number, b: number, c: number, k: number): number =>
  k * (1 - (c * c) / (b * b) + 2 * Math.log(c / a));
