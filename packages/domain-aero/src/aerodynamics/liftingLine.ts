/**
 * Prandtl lifting-line theory, Glauert's Fourier solution of the monoplane equation for a symmetric wing (odd terms only):
 * Σ A_n sin nθ (sin θ + n μ) = μ (α - α_L0) sin θ, μ = c a0 / (4 b), y = -(b/2) cos θ
 * (Glauert, "The Elements of Aerofoil and Airscrew Theory", 1926, ch. XI; Anderson, Fundamentals of Aerodynamics §5.3).
 */

import { solveLinear } from '@core/model/materialLaws/linalg';

export interface WingGeometry {
  readonly span: number;
  /** Chord at the spanwise station η = 2|y|/b in [0, 1]. */
  readonly chordAt: (eta: number) => number;
  /** Geometric twist (rad, + = nose up, washout negative) at η. */
  readonly twistAt: (eta: number) => number;
  /** Section lift slope a0 per rad. */
  readonly sectionLiftSlope: number;
  /** Section zero-lift angle α_L0 (rad). */
  readonly zeroLiftAngle: number;
}

export interface LiftingLineSolution {
  /** Odd Fourier coefficients A1, A3, A5, … */
  readonly coefficients: readonly number[];
  readonly cl: number;
  readonly cdi: number;
  /** Span efficiency e = CL² / (π AR CDi) (Oswald factor of the induced drag). */
  readonly spanEfficiency: number;
  /** Station loads from root to tip: η, local chord, local cl, cl·c/c_ref (span loading). */
  readonly stations: ReadonlyArray<{ readonly eta: number; readonly chord: number; readonly cl: number; readonly loading: number }>;
}

/** Wing area S = b ∫0^1 c(η) dη (Simpson, 2000 intervals). */
export function wingArea(wing: Pick<WingGeometry, 'span' | 'chordAt'>): number {
  const steps = 2000;
  let sum = wing.chordAt(0) + wing.chordAt(1);
  for (let k = 1; k < steps; k += 1) sum += (k % 2 === 1 ? 4 : 2) * wing.chordAt(k / steps);
  return (wing.span * sum) / (3 * steps);
}

/**
 * Collocation at θ_k = kπ/(2N), k = 1..N (half span, root at θ = π/2) for N odd terms.
 * @failure singular system -> null
 */
export function solveLiftingLine(
  wing: WingGeometry,
  alpha: number,
  terms: number,
  area: number = wingArea(wing),
): LiftingLineSolution | null {
  const aspectRatio = (wing.span * wing.span) / area;
  const orders = Array.from({ length: terms }, (_, index) => 2 * index + 1);
  const thetas = Array.from({ length: terms }, (_, index) => ((index + 1) * Math.PI) / (2 * terms));
  const matrix = thetas.map((theta) => {
    const eta = Math.abs(Math.cos(theta));
    const mu = (wing.chordAt(eta) * wing.sectionLiftSlope) / (4 * wing.span);
    return orders.map((n) => Math.sin(n * theta) * (Math.sin(theta) + n * mu));
  });
  const rhs = thetas.map((theta) => {
    const eta = Math.abs(Math.cos(theta));
    const mu = (wing.chordAt(eta) * wing.sectionLiftSlope) / (4 * wing.span);
    return mu * (alpha + wing.twistAt(eta) - wing.zeroLiftAngle) * Math.sin(theta);
  });
  const coefficients = solveLinear(matrix, rhs);
  if (coefficients === null || coefficients.some((value) => !Number.isFinite(value))) return null;
  const a1 = coefficients[0] as number;
  const cl = Math.PI * aspectRatio * a1;
  const cdi = Math.PI * aspectRatio * orders.reduce((sum, n, index) => sum + n * (coefficients[index] as number) ** 2, 0);
  const meanChord = area / wing.span;
  const stations = [...thetas].reverse().map((theta) => {
    const eta = Math.abs(Math.cos(theta));
    const chord = wing.chordAt(eta);
    const circulationTerm = orders.reduce((sum, n, index) => sum + (coefficients[index] as number) * Math.sin(n * theta), 0);
    const local = (4 * wing.span * circulationTerm) / chord;
    return { eta, chord, cl: local, loading: (local * chord) / meanChord };
  });
  return { coefficients, cl, cdi, spanEfficiency: cdi > 0 ? (cl * cl) / (Math.PI * aspectRatio * cdi) : 1, stations };
}
