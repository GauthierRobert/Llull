/** FORM (improved Hasofer-Lind / Rackwitz-Fiessler iteration) and SORM (Breitung) in the standard normal space. Pure numerics. */

import { normalCdf } from '@lib/specialFunctions';
import { symmetricEigenvalues } from './numerics';

export const FD_STEP_U = 1e-6;
const HESSIAN_STEP = 1e-3;
const MAX_HALVINGS = 10;

export interface FormOptions {
  readonly maxIterations: number;
  /** Stop when the largest change of a u component is below this. */
  readonly tolerance: number;
}

export interface FormResult {
  /** Signed reliability index: negative when the origin lies in the failure domain. */
  readonly beta: number;
  readonly pf: number;
  /** Design point (most probable failure point) in u space. */
  readonly u: number[];
  /** Unit vector from the origin to the design point direction (-grad g / |grad g|). */
  readonly alpha: number[];
  readonly gAtOrigin: number;
  readonly g: number;
  readonly iterations: number;
  readonly converged: boolean;
}

const norm = (v: readonly number[]): number => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

/** Central-difference gradient of g at u. */
function gradient(g: (u: number[]) => number, u: readonly number[]): number[] {
  return u.map((_, i) => {
    const up = [...u];
    const down = [...u];
    up[i] = (u[i] ?? 0) + FD_STEP_U;
    down[i] = (u[i] ?? 0) - FD_STEP_U;
    return (g(up) - g(down)) / (2 * FD_STEP_U);
  });
}

/**
 * HL-RF from u = 0 with step halving when |g| grows (at most 10 halvings).
 * @invariant exact (one iteration) for g linear in u; beta < 0 when g(0) < 0
 * @failure a non-finite g or a vanishing gradient stops with converged: false and the last iterate
 */
export function runForm(g: (u: number[]) => number, dimension: number, options: FormOptions): FormResult {
  let u = new Array<number>(dimension).fill(0);
  const gAtOrigin = g(u);
  let value = gAtOrigin;
  let grad = gradient(g, u);
  let iterations = 0;
  let converged = false;
  const scale = Math.max(Math.abs(gAtOrigin), 1e-12);
  while (iterations < options.maxIterations && Number.isFinite(value)) {
    const length = norm(grad);
    if (!(length > 1e-14)) break;
    iterations += 1;
    const factor = (dot(grad, u) - value) / (length * length);
    const target = grad.map((component) => factor * component);
    let next = target;
    let nextValue = g(next);
    for (let halving = 0; halving < MAX_HALVINGS && Math.abs(nextValue) > Math.abs(value) && iterations > 1; halving += 1) {
      next = next.map((component, i) => (component + (u[i] ?? 0)) / 2);
      nextValue = g(next);
    }
    const change = Math.max(...next.map((component, i) => Math.abs(component - (u[i] ?? 0))));
    u = next;
    value = nextValue;
    grad = gradient(g, u);
    if (change < options.tolerance && Math.abs(value) < 1e-6 * scale) {
      converged = true;
      break;
    }
  }
  const length = norm(grad);
  const alpha = length > 0 ? grad.map((component) => -component / length) : new Array<number>(dimension).fill(0);
  const beta = gAtOrigin < 0 ? -norm(u) : norm(u);
  return { beta, pf: normalCdf(-beta), u, alpha, gAtOrigin, g: value, iterations, converged };
}

/** Orthonormal basis of R^n whose LAST vector is `last` (Gram-Schmidt over the coordinate axes). */
function basisEndingWith(last: readonly number[]): number[][] {
  const n = last.length;
  const basis: number[][] = [];
  const candidates: number[][] = last.map((_, i) => last.map((__, j) => (i === j ? 1 : 0)));
  const anchor = [...last];
  for (const candidate of candidates) {
    if (basis.length === n - 1) break;
    const v = [...candidate];
    for (const b of [...basis, anchor]) {
      const projection = dot(v, b);
      b.forEach((x, i) => {
        v[i] = (v[i] ?? 0) - projection * x;
      });
    }
    const length = norm(v);
    if (length > 1e-8) basis.push(v.map((x) => x / length));
  }
  return [...basis, anchor];
}

export interface SormResult {
  /** Principal curvatures of the limit state at the design point (positive: curved away from the origin). */
  readonly curvatures: number[];
  /** Breitung failure probability, or null when 1 + beta * kappa <= 0 for some curvature. */
  readonly pf: number | null;
}

/**
 * Breitung SORM at a FORM design point with beta > 0.
 * @invariant g = 3 - u1 + 0.1 u2^2 gives kappa = 0.2 and Pf = Φ(-3) / sqrt(1.6)
 */
export function runSorm(g: (u: number[]) => number, form: FormResult): SormResult {
  const n = form.u.length;
  const grad = gradient(g, form.u);
  const length = norm(grad);
  const hessian = form.u.map((_, i) =>
    form.u.map((__, j) => {
      const at = (si: number, sj: number): number => {
        const point = [...form.u];
        point[i] = (point[i] ?? 0) + si * HESSIAN_STEP;
        point[j] = (point[j] ?? 0) + sj * HESSIAN_STEP;
        return g(point);
      };
      return (at(1, 1) - at(1, -1) - at(-1, 1) + at(-1, -1)) / (4 * HESSIAN_STEP * HESSIAN_STEP);
    }),
  );
  const basis = basisEndingWith(form.alpha);
  const rotated = basis.map((row) =>
    basis.map((column) =>
      dot(
        row,
        hessian.map((hRow) => dot(hRow, column)),
      ),
    ),
  );
  const block = rotated.slice(0, n - 1).map((row) => row.slice(0, n - 1).map((value) => value / length));
  const curvatures = n > 1 ? symmetricEigenvalues(block) : [];
  if (curvatures.some((kappa) => 1 + form.beta * kappa <= 0)) return { curvatures, pf: null };
  return { curvatures, pf: curvatures.reduce((product, kappa) => product / Math.sqrt(1 + form.beta * kappa), normalCdf(-form.beta)) };
}
