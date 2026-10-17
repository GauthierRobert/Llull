/**
 * Incompressible hyperelasticity in homogeneous modes (PHY-02 §5.6): nominal and Cauchy stresses for W(I1, I2) laws (Neo-Hooke,
 * Mooney-Rivlin, polynomial, reduced polynomial, Yeoh, Arruda-Boyce) and Ogden, strain energy, initial shear modulus, and the
 * Ogden-1972 → canonical (CalculiX / Abaqus) convention. Stresses in the unit of the parameters (the callers use MPa).
 */

export type HyperMode = 'UT' | 'ET' | 'PS';
export const HYPER_MODES: readonly HyperMode[] = ['UT', 'ET', 'PS'];

/** Derivatives of W(I1, I2). */
export interface InvariantDerivatives {
  readonly W: number;
  readonly W1: number;
  readonly W2: number;
  readonly W11: number;
  readonly W12: number;
  readonly W22: number;
}

/** A hyperelastic law resolved to numbers: an invariant-based W(I1, I2) or an Ogden series (canonical μ_i, α_i). */
export type ResolvedHyper =
  | { readonly kind: 'invariant'; readonly derivatives: (i1: number, i2: number) => InvariantDerivatives; readonly shearModulus: number }
  | { readonly kind: 'ogden'; readonly mu: readonly number[]; readonly alpha: readonly number[]; readonly shearModulus: number };

/** Σ c_ij (I1−3)^i (I2−3)^j with its first and second derivatives. */
export function polynomialDerivatives(
  terms: ReadonlyArray<readonly [i: number, j: number, c: number]>,
): (i1: number, i2: number) => InvariantDerivatives {
  return (i1, i2) => {
    const x = i1 - 3;
    const y = i2 - 3;
    let W = 0;
    let W1 = 0;
    let W2 = 0;
    let W11 = 0;
    let W12 = 0;
    let W22 = 0;
    for (const [i, j, c] of terms) {
      W += c * x ** i * y ** j;
      if (i > 0) W1 += c * i * x ** (i - 1) * y ** j;
      if (j > 0) W2 += c * j * x ** i * y ** (j - 1);
      if (i > 1) W11 += c * i * (i - 1) * x ** (i - 2) * y ** j;
      if (j > 1) W22 += c * j * (j - 1) * x ** i * y ** (j - 2);
      if (i > 0 && j > 0) W12 += c * i * j * x ** (i - 1) * y ** (j - 1);
    }
    return { W, W1, W2, W11, W12, W22 };
  };
}

/** Arruda-Boyce 5-term series coefficients (CalculiX manual, Arruda & Boyce 1993). */
const AB_COEFFICIENTS = [1 / 2, 1 / 20, 11 / 1050, 19 / 7000, 519 / 673750] as const;

export function arrudaBoyceDerivatives(mu: number, lambdaM: number): (i1: number, i2: number) => InvariantDerivatives {
  return (i1) => {
    let W = 0;
    let W1 = 0;
    let W11 = 0;
    AB_COEFFICIENTS.forEach((c, k) => {
      const order = k + 1;
      const scale = mu * c * lambdaM ** (-2 * k);
      W += scale * (i1 ** order - 3 ** order);
      W1 += scale * order * i1 ** (order - 1);
      if (order > 1) W11 += scale * order * (order - 1) * i1 ** (order - 2);
    });
    return { W, W1, W2: 0, W11, W12: 0, W22: 0 };
  };
}

/** Principal stretches of a mode at nominal stretch λ (incompressible). */
export function modeStretches(mode: HyperMode, lambda: number): [number, number, number] {
  if (mode === 'UT') return [lambda, 1 / Math.sqrt(lambda), 1 / Math.sqrt(lambda)];
  if (mode === 'ET') return [lambda, lambda, 1 / (lambda * lambda)];
  return [lambda, 1, 1 / lambda];
}

const invariantsOf = (stretches: readonly [number, number, number]): { readonly i1: number; readonly i2: number } => {
  const [a, b, c] = stretches;
  return { i1: a * a + b * b + c * c, i2: (a * b) ** 2 + (b * c) ** 2 + (c * a) ** 2 };
};

/** Nominal (first Piola-Kirchhoff) stress in the loading direction, TECHNICAL_SPEC §5.6 table / Ogden sums. */
export function nominalStress(law: ResolvedHyper, mode: HyperMode, lambda: number): number {
  if (law.kind === 'ogden') {
    const exponent = mode === 'UT' ? (a: number) => -a / 2 - 1 : mode === 'ET' ? (a: number) => -2 * a - 1 : (a: number) => -a - 1;
    return law.mu.reduce((sum, mu, k) => {
      const alpha = law.alpha[k] ?? 1;
      return sum + ((2 * mu) / alpha) * (lambda ** (alpha - 1) - lambda ** exponent(alpha));
    }, 0);
  }
  const { i1, i2 } = invariantsOf(modeStretches(mode, lambda));
  const { W1, W2 } = law.derivatives(i1, i2);
  if (mode === 'UT') return 2 * (lambda - lambda ** -2) * (W1 + W2 / lambda);
  if (mode === 'ET') return 2 * (lambda - lambda ** -5) * (W1 + lambda * lambda * W2);
  return 2 * (lambda - lambda ** -3) * (W1 + W2);
}

/** Cauchy stresses with σ3 = 0 (free thickness / lateral direction) at the principal stretches of the mode. */
export function cauchyStresses(law: ResolvedHyper, stretches: readonly [number, number, number]): [number, number, number] {
  const [a, b, c] = stretches;
  if (law.kind === 'ogden') {
    const diff = (x: number): number =>
      law.mu.reduce((sum, mu, k) => sum + ((2 * mu) / (law.alpha[k] ?? 1)) * (x ** (law.alpha[k] ?? 1) - c ** (law.alpha[k] ?? 1)), 0);
    return [diff(a), diff(b), 0];
  }
  const { i1, i2 } = invariantsOf(stretches);
  const { W1, W2 } = law.derivatives(i1, i2);
  const diff = (x: number): number => 2 * W1 * (x * x - c * c) - 2 * W2 * (x ** -2 - c ** -2);
  return [diff(a), diff(b), 0];
}

/** Strain energy density W at the principal stretches. */
export function strainEnergy(law: ResolvedHyper, stretches: readonly [number, number, number]): number {
  if (law.kind === 'ogden') {
    return law.mu.reduce((sum, mu, k) => {
      const alpha = law.alpha[k] ?? 1;
      return sum + ((2 * mu) / (alpha * alpha)) * stretches.reduce((acc, s) => acc + s ** alpha, -3);
    }, 0);
  }
  const { i1, i2 } = invariantsOf(stretches);
  return law.derivatives(i1, i2).W;
}

/** Ogden 1972 convention W = Σ μ_p/α_p (...) → canonical W = Σ 2μ_i/α_i² (...): μ_i = μ_p α_p / 2. */
export const ogden1972ToCanonical = (muP: number, alpha: number): number => (muP * alpha) / 2;

/** Initial shear modulus of an Ogden series: Σ μ_i (canonical) = ½ Σ μ_p α_p. */
export const ogdenShearModulus = (mu: readonly number[]): number => mu.reduce((sum, value) => sum + value, 0);
