/**
 * Inviscid 2D airfoil analysis: linear-strength vortex panel method with the Kutta condition γ_TE,upper + γ_TE,lower = 0 (Kuethe & Chow,
 * "Foundations of Aerodynamics", §5.10 program VORTEX; Katz & Plotkin §11.4), plus thin-airfoil theory integrals of the mean line.
 */

import { luFactor, luSolve } from '@lib/denseLinalg';

export interface PanelSolution {
  readonly cl: number;
  /** Lift from the circulation (Kutta-Joukowski); equals `cl` as panels -> ∞. */
  readonly clCirculation: number;
  /** Pitching moment about (momentX, 0), nose-up positive. */
  readonly cm: number;
  /** Pressure drag of the inviscid solution (d'Alembert: -> 0 with refinement); a discretization check, not a drag prediction. */
  readonly cdPressure: number;
  /** Control points (panel midpoints), surface velocity ratio V/V∞ and Cp = 1 - (V/V∞)², from the lower trailing edge round to the upper one. */
  readonly surface: ReadonlyArray<{ readonly x: number; readonly y: number; readonly cp: number; readonly velocityRatio: number }>;
}

/**
 * Solve the flow at each angle of attack in `alphas` (rad) about a closed contour given clockwise (lower TE -> LE -> upper TE), chord along x.
 * @invariant the influence matrix is built and LU-factorised once (Float64Array, RS1 §5); γ(α) = cos α γ(0) + sin α γ(π/2) from two
 *   right-hand sides on that one factorisation (the boundary condition is linear in α)
 * @failure singular influence matrix -> null
 */
export function solveVortexPanels(
  nodes: ReadonlyArray<readonly [number, number]>,
  alphas: readonly number[],
  momentX: number,
): PanelSolution[] | null {
  const m = nodes.length - 1;
  const node = (j: number): readonly [number, number] => nodes[j] as readonly [number, number];
  const xs = Array.from({ length: m }, (_, i) => (node(i)[0] + node(i + 1)[0]) / 2);
  const ys = Array.from({ length: m }, (_, i) => (node(i)[1] + node(i + 1)[1]) / 2);
  const lengths = Array.from({ length: m }, (_, i) => Math.hypot(node(i + 1)[0] - node(i)[0], node(i + 1)[1] - node(i)[1]));
  const angles = Array.from({ length: m }, (_, i) => Math.atan2(node(i + 1)[1] - node(i)[1], node(i + 1)[0] - node(i)[0]));
  const size = m + 1;
  const an = new Float64Array(size * size);
  const at = new Float64Array(m * size);
  for (let i = 0; i < m; i += 1) {
    const ti = angles[i] as number;
    const row = i * size;
    for (let j = 0; j < m; j += 1) {
      let cn1 = -1;
      let cn2 = 1;
      let ct1 = Math.PI / 2;
      let ct2 = Math.PI / 2;
      if (i !== j) {
        const tj = angles[j] as number;
        const sj = lengths[j] as number;
        const dx = (xs[i] as number) - node(j)[0];
        const dy = (ys[i] as number) - node(j)[1];
        const a = -dx * Math.cos(tj) - dy * Math.sin(tj);
        const b = dx * dx + dy * dy;
        const c = Math.sin(ti - tj);
        const d = Math.cos(ti - tj);
        const e = dx * Math.sin(tj) - dy * Math.cos(tj);
        const f = Math.log(1 + (sj * (sj + 2 * a)) / b);
        const g = Math.atan2(e * sj, b + a * sj);
        const p = dx * Math.sin(ti - 2 * tj) + dy * Math.cos(ti - 2 * tj);
        const q = dx * Math.cos(ti - 2 * tj) - dy * Math.sin(ti - 2 * tj);
        cn2 = d + (0.5 * q * f) / sj - ((a * c + d * e) * g) / sj;
        cn1 = 0.5 * d * f + c * g - cn2;
        ct2 = c + (0.5 * p * f) / sj + ((a * d - c * e) * g) / sj;
        ct1 = 0.5 * c * f - d * g - ct2;
      }
      an[row + j] = (an[row + j] as number) + cn1;
      an[row + j + 1] = (an[row + j + 1] as number) + cn2;
      at[row + j] = (at[row + j] as number) + ct1;
      at[row + j + 1] = (at[row + j + 1] as number) + ct2;
    }
  }
  an[m * size] = 1;
  an[m * size + m] = 1;
  const factors = luFactor(an, size);
  if (factors === null) return null;
  const atZero = luSolve(factors, [...angles.map((theta) => Math.sin(theta)), 0]);
  const atRight = luSolve(factors, [...angles.map((theta) => -Math.cos(theta)), 0]);
  if ([...atZero, ...atRight].some((value) => !Number.isFinite(value))) return null;
  const xMax = Math.max(...nodes.map(([x]) => x));
  const xMin = Math.min(...nodes.map(([x]) => x));
  const chord = xMax - xMin;
  const panelForces = (gamma: ArrayLike<number>, alpha: number): PanelSolution => {
    const surface = Array.from({ length: m }, (_, i) => {
      let tangential = Math.cos((angles[i] as number) - alpha);
      for (let j = 0; j < size; j += 1) tangential += (at[i * size + j] as number) * (gamma[j] as number);
      return { x: xs[i] as number, y: ys[i] as number, velocityRatio: tangential, cp: 1 - tangential * tangential };
    });
    let fx = 0;
    let fy = 0;
    let moment = 0;
    surface.forEach((point, i) => {
      const theta = angles[i] as number;
      const s = lengths[i] as number;
      const dFx = point.cp * Math.sin(theta) * s;
      const dFy = -point.cp * Math.cos(theta) * s;
      fx += dFx;
      fy += dFy;
      moment -= (point.x - momentX) * dFy - point.y * dFx;
    });
    const circulation = lengths.reduce((sum, s, j) => sum + (((gamma[j] as number) + (gamma[j + 1] as number)) / 2) * s, 0) * 2 * Math.PI;
    return {
      cl: (fy * Math.cos(alpha) - fx * Math.sin(alpha)) / chord,
      clCirculation: (2 * circulation) / chord,
      cm: moment / (chord * chord),
      cdPressure: (fx * Math.cos(alpha) + fy * Math.sin(alpha)) / chord,
      surface,
    };
  };
  return alphas.map((alpha) =>
    panelForces(
      atZero.map((value, j) => Math.cos(alpha) * value + Math.sin(alpha) * (atRight[j] as number)),
      alpha,
    ),
  );
}

export interface ThinAirfoil {
  /** Zero-lift angle α_L0 (rad). */
  readonly zeroLiftAngle: number;
  /** Lift slope 2π per rad. */
  readonly liftSlope: number;
  /** c_m about the quarter chord, (π/4)(A2 - A1). */
  readonly cmQuarterChord: number;
}

/** Thin-airfoil theory from the mean-line slope dz/dx(x), x = (1 - cos θ)/2, midpoint rule in θ with `steps` intervals. */
export function thinAirfoil(slope: (x: number) => number, steps = 4000): ThinAirfoil {
  let zeroLift = 0;
  let a1 = 0;
  let a2 = 0;
  for (let k = 0; k < steps; k += 1) {
    const theta = ((k + 0.5) * Math.PI) / steps;
    const dz = slope((1 - Math.cos(theta)) / 2) * (Math.PI / steps);
    zeroLift += dz * (Math.cos(theta) - 1);
    a1 += dz * Math.cos(theta);
    a2 += dz * Math.cos(2 * theta);
  }
  return {
    zeroLiftAngle: -zeroLift / Math.PI,
    liftSlope: 2 * Math.PI,
    cmQuarterChord: (Math.PI / 4) * ((2 / Math.PI) * a2 - (2 / Math.PI) * a1),
  };
}
