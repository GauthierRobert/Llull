/**
 * Inviscid 2D airfoil analysis: linear-strength vortex panel method with the Kutta condition γ_TE,upper + γ_TE,lower = 0 (Kuethe & Chow,
 * "Foundations of Aerodynamics", §5.10 program VORTEX; Katz & Plotkin §11.4), plus thin-airfoil theory integrals of the mean line.
 */

import { solveLinear } from '@core/model/materialLaws/linalg';

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
 * Solve the flow at angle of attack `alpha` (rad) about a closed contour given clockwise (lower TE -> LE -> upper TE), chord along x.
 * @failure singular influence matrix -> null
 */
export function solveVortexPanels(nodes: ReadonlyArray<readonly [number, number]>, alpha: number, momentX: number): PanelSolution | null {
  const m = nodes.length - 1;
  const node = (j: number): readonly [number, number] => nodes[j] as readonly [number, number];
  const xs = Array.from({ length: m }, (_, i) => (node(i)[0] + node(i + 1)[0]) / 2);
  const ys = Array.from({ length: m }, (_, i) => (node(i)[1] + node(i + 1)[1]) / 2);
  const lengths = Array.from({ length: m }, (_, i) => Math.hypot(node(i + 1)[0] - node(i)[0], node(i + 1)[1] - node(i)[1]));
  const angles = Array.from({ length: m }, (_, i) => Math.atan2(node(i + 1)[1] - node(i)[1], node(i + 1)[0] - node(i)[0]));
  const an = Array.from({ length: m + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = Array.from({ length: m }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i < m; i += 1) {
    const ti = angles[i] as number;
    const rowN = an[i] as number[];
    const rowT = at[i] as number[];
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
      rowN[j] = (rowN[j] as number) + cn1;
      rowN[j + 1] = (rowN[j + 1] as number) + cn2;
      rowT[j] = (rowT[j] as number) + ct1;
      rowT[j + 1] = (rowT[j + 1] as number) + ct2;
    }
  }
  const kutta = an[m] as number[];
  kutta[0] = 1;
  kutta[m] = 1;
  const rhs = [...angles.map((theta) => Math.sin(theta - alpha)), 0];
  const gamma = solveLinear(an, rhs);
  if (gamma === null || gamma.some((value) => !Number.isFinite(value))) return null;
  const surface = Array.from({ length: m }, (_, i) => {
    const tangential = (at[i] as number[]).reduce(
      (sum, coefficient, j) => sum + coefficient * (gamma[j] as number),
      Math.cos((angles[i] as number) - alpha),
    );
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
  const xMax = Math.max(...nodes.map(([x]) => x));
  const xMin = Math.min(...nodes.map(([x]) => x));
  const chord = xMax - xMin;
  const circulation = lengths.reduce((sum, s, j) => sum + (((gamma[j] as number) + (gamma[j + 1] as number)) / 2) * s, 0) * 2 * Math.PI;
  return {
    cl: (fy * Math.cos(alpha) - fx * Math.sin(alpha)) / chord,
    clCirculation: (2 * circulation) / chord,
    cm: moment / (chord * chord),
    cdPressure: (fx * Math.cos(alpha) + fy * Math.sin(alpha)) / chord,
    surface,
  };
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
