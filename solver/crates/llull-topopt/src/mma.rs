//! Method of moving asymptotes (Svanberg 1987, with the asymptote and bound rules of Svanberg's 2002 / 2007 MMA notes),
//! written from the published algorithm (no GPL code): `min f0(x)  s.t.  fi(x) ≤ 0 (i = 1..m),  xmin ≤ x ≤ xmax`.
//!
//! Each outer step replaces f0 and fi by separable convex approximations built from the current gradients and the moving
//! asymptotes `low < x < upp`, and solves that subproblem exactly through its dual (Svanberg 1987 §4): for multipliers
//! `λ ≥ 0` the primal `x(λ)` is closed-form per variable, the dual `W(λ)` is concave, and it is maximised by a projected
//! Newton iteration with an Armijo line search (exact Hessian; a damped gradient step where the Hessian is singular). The
//! artificial variables `y_i` (constraint relaxation, cost `c_i y + ½ d_i y²`) of the standard formulation are kept, `z`
//! (a_i = 0) is not needed. Every sum over the variables runs in a fixed order, so the step is bit-identical for any thread count.
//!
//! State between steps (`low`, `upp`, `xold1`, `xold2`, the step count) is exposed by [`Mma::state`] / [`Mma::restore`] so a
//! job can checkpoint and resume it bit for bit.

use llull_gpu::reduce::sum;
use llull_voxfe::MIN_LEN;
use rayon::prelude::*;

/// Asymptote and move constants (Svanberg 2007 defaults).
const ASY_INIT: f64 = 0.5;
const ASY_INCR: f64 = 1.2;
const ASY_DECR: f64 = 0.7;
const ALBEFA: f64 = 0.1;
const RAA0: f64 = 1e-5;
/// Relaxation cost `c_i` and curvature `d_i` of the artificial variables.
const RELAX_COST: f64 = 1000.0;
const RELAX_CURVATURE: f64 = 1.0;
/// Dual solver: projected-gradient tolerance (relative to max(1, |b_i|)) and iteration cap.
const DUAL_TOLERANCE: f64 = 1e-11;
const DUAL_MAX_ITERATIONS: usize = 500;

/// Bounds of every variable and the move limit as a fraction of `xmax − xmin`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pub xmin: f64,
    pub xmax: f64,
    pub move_limit: f64,
}

/// One MMA optimiser over `n` variables and `m` constraints.
#[derive(Debug, Clone, PartialEq)]
pub struct Mma {
    n: usize,
    m: usize,
    low: Vec<f64>,
    upp: Vec<f64>,
    xold1: Vec<f64>,
    xold2: Vec<f64>,
    /// Outer steps taken so far.
    iteration: usize,
}

/// The separable approximation of one step: `Σ_j p_j / (upp_j − x_j) + q_j / (x_j − low_j)` per function.
struct Approximation {
    low: Vec<f64>,
    upp: Vec<f64>,
    alfa: Vec<f64>,
    beta: Vec<f64>,
    p0: Vec<f64>,
    q0: Vec<f64>,
    /// `m × n`, row i = constraint i.
    p: Vec<Vec<f64>>,
    q: Vec<Vec<f64>>,
    b: Vec<f64>,
}

impl Mma {
    pub fn new(n: usize, m: usize) -> Mma {
        Mma { n, m, low: vec![0.0; n], upp: vec![0.0; n], xold1: vec![0.0; n], xold2: vec![0.0; n], iteration: 0 }
    }

    pub fn iteration(&self) -> usize {
        self.iteration
    }

    /// The state a later [`Mma::restore`] continues from: `low, upp, xold1, xold2` (4 n values) and the step count.
    pub fn state(&self) -> (Vec<f64>, usize) {
        let mut values = Vec::with_capacity(4 * self.n);
        for part in [&self.low, &self.upp, &self.xold1, &self.xold2] {
            values.extend_from_slice(part);
        }
        (values, self.iteration)
    }

    /// Restores a [`Mma::state`]; `None` when the lengths do not match this optimiser.
    pub fn restore(n: usize, m: usize, values: &[f64], iteration: usize) -> Option<Mma> {
        if values.len() != 4 * n {
            return None;
        }
        let part = |k: usize| values[k * n..(k + 1) * n].to_vec();
        Some(Mma { n, m, low: part(0), upp: part(1), xold1: part(2), xold2: part(3), iteration })
    }

    /// One MMA step from `x` with the objective gradient `df0`, the constraint values `f` (m) and gradients `df` (m rows of n).
    /// Returns the new design. Panics on mismatched lengths.
    pub fn step(&mut self, x: &[f64], df0: &[f64], f: &[f64], df: &[Vec<f64>], bounds: Bounds) -> Vec<f64> {
        assert!(x.len() == self.n && df0.len() == self.n && f.len() == self.m && df.len() == self.m, "MMA: sizes do not match");
        assert!(df.iter().all(|row| row.len() == self.n), "MMA: constraint gradient rows must have n entries");
        self.iteration += 1;
        let approximation = self.approximate(x, df0, f, df, bounds);
        let lambda = solve_dual(&approximation, self.m);
        let x_new = primal(&approximation, &lambda);
        self.xold2 = std::mem::take(&mut self.xold1);
        self.xold1 = x.to_vec();
        self.low = approximation.low;
        self.upp = approximation.upp;
        x_new
    }

    fn approximate(&self, x: &[f64], df0: &[f64], f: &[f64], df: &[Vec<f64>], bounds: Bounds) -> Approximation {
        let range = (bounds.xmax - bounds.xmin).max(1e-5);
        let (low, upp): (Vec<f64>, Vec<f64>) = if self.iteration <= 2 {
            (x.iter().map(|v| v - ASY_INIT * range).collect(), x.iter().map(|v| v + ASY_INIT * range).collect())
        } else {
            (0..self.n)
                .map(|j| {
                    let trend = (x[j] - self.xold1[j]) * (self.xold1[j] - self.xold2[j]);
                    let factor = if trend > 0.0 {
                        ASY_INCR
                    } else if trend < 0.0 {
                        ASY_DECR
                    } else {
                        1.0
                    };
                    let low = x[j] - factor * (self.xold1[j] - self.low[j]);
                    let upp = x[j] + factor * (self.upp[j] - self.xold1[j]);
                    (low.clamp(x[j] - 10.0 * range, x[j] - 0.01 * range), upp.clamp(x[j] + 0.01 * range, x[j] + 10.0 * range))
                })
                .unzip()
        };
        let alfa: Vec<f64> =
            (0..self.n).map(|j| bounds.xmin.max(low[j] + ALBEFA * (x[j] - low[j])).max(x[j] - bounds.move_limit * range)).collect();
        let beta: Vec<f64> = (0..self.n)
            .map(|j| bounds.xmax.min(upp[j] - ALBEFA * (upp[j] - x[j])).min(x[j] + bounds.move_limit * range).max(alfa[j]))
            .collect();
        let coefficients = |gradient: &[f64]| -> (Vec<f64>, Vec<f64>) {
            (0..self.n)
                .map(|j| {
                    let (plus, minus) = (gradient[j].max(0.0), (-gradient[j]).max(0.0));
                    let (ux, xl) = (upp[j] - x[j], x[j] - low[j]);
                    (ux * ux * (1.001 * plus + 0.001 * minus + RAA0 / range), xl * xl * (0.001 * plus + 1.001 * minus + RAA0 / range))
                })
                .unzip()
        };
        let (p0, q0) = coefficients(df0);
        let mut p = Vec::with_capacity(self.m);
        let mut q = Vec::with_capacity(self.m);
        let mut b = Vec::with_capacity(self.m);
        for (i, gradient) in df.iter().enumerate() {
            let (pi, qi) = coefficients(gradient);
            let terms: Vec<f64> = (0..self.n).map(|j| pi[j] / (upp[j] - x[j]) + qi[j] / (x[j] - low[j])).collect();
            b.push(sum(&terms) - f[i]);
            p.push(pi);
            q.push(qi);
        }
        Approximation { low, upp, alfa, beta, p0, q0, p, q, b }
    }
}

/// `p_j(λ), q_j(λ)` for one variable.
#[inline]
fn combined(a: &Approximation, lambda: &[f64], j: usize) -> (f64, f64) {
    let mut p = a.p0[j];
    let mut q = a.q0[j];
    for (i, l) in lambda.iter().enumerate() {
        p += l * a.p[i][j];
        q += l * a.q[i][j];
    }
    (p, q)
}

/// The subproblem's minimiser for the multipliers `λ`: closed form per variable, clamped to `[alfa, beta]`.
fn primal(a: &Approximation, lambda: &[f64]) -> Vec<f64> {
    (0..a.low.len())
        .into_par_iter()
        .with_min_len(MIN_LEN)
        .map(|j| {
            let (p, q) = combined(a, lambda, j);
            let (sp, sq) = (p.sqrt(), q.sqrt());
            let x = (sp * a.low[j] + sq * a.upp[j]) / (sp + sq);
            x.clamp(a.alfa[j], a.beta[j])
        })
        .collect()
}

/// `y_i(λ) = max(0, (λ_i − c_i) / d_i)`.
fn relaxation(lambda: f64) -> f64 {
    ((lambda - RELAX_COST) / RELAX_CURVATURE).max(0.0)
}

/// Dual value `W(λ)`, its gradient and Hessian at `λ` (the primal `x(λ)` is recomputed).
fn dual(a: &Approximation, lambda: &[f64], m: usize) -> (f64, Vec<f64>, Vec<Vec<f64>>) {
    let x = primal(a, lambda);
    let n = x.len();
    // per variable: the primal term of W, the constraint terms g_i, and the curvature data for the Hessian
    let rows: Vec<Vec<f64>> = (0..n)
        .into_par_iter()
        .with_min_len(MIN_LEN)
        .map(|j| {
            let (p, q) = combined(a, lambda, j);
            let (ux, xl) = (a.upp[j] - x[j], x[j] - a.low[j]);
            let mut row = Vec::with_capacity(1 + m + m * m);
            row.push(p / ux + q / xl);
            for i in 0..m {
                row.push(a.p[i][j] / ux + a.q[i][j] / xl);
            }
            let interior = x[j] > a.alfa[j] && x[j] < a.beta[j];
            let curvature = 2.0 * p / (ux * ux * ux) + 2.0 * q / (xl * xl * xl);
            for i in 0..m {
                let gi = a.p[i][j] / (ux * ux) - a.q[i][j] / (xl * xl);
                for k in 0..m {
                    let gk = a.p[k][j] / (ux * ux) - a.q[k][j] / (xl * xl);
                    row.push(if interior && curvature > 0.0 { -gi * gk / curvature } else { 0.0 });
                }
            }
            row
        })
        .collect();
    let column = |c: usize| -> f64 {
        let values: Vec<f64> = rows.iter().map(|row| row[c]).collect();
        sum(&values)
    };
    let mut value = column(0);
    let mut gradient = Vec::with_capacity(m);
    for (i, &l) in lambda.iter().enumerate() {
        let y = relaxation(l);
        value += RELAX_COST * y + 0.5 * RELAX_CURVATURE * y * y - l * y - l * a.b[i];
        gradient.push(column(1 + i) - a.b[i] - y);
    }
    let mut hessian = vec![vec![0.0; m]; m];
    for (i, row) in hessian.iter_mut().enumerate() {
        for (k, entry) in row.iter_mut().enumerate() {
            *entry = column(1 + m + i * m + k);
        }
        if lambda[i] > RELAX_COST {
            row[i] -= 1.0 / RELAX_CURVATURE;
        }
    }
    (value, gradient, hessian)
}

/// Solves `(−H + μ I) d = g` by Gaussian elimination with partial pivoting (m is small). `None` when singular.
fn ascent_direction(hessian: &[Vec<f64>], gradient: &[f64]) -> Option<Vec<f64>> {
    let m = gradient.len();
    let scale = hessian.iter().enumerate().map(|(i, row)| row[i].abs()).fold(1.0, f64::max);
    let mut a: Vec<Vec<f64>> =
        (0..m).map(|i| (0..m).map(|k| -hessian[i][k] + if i == k { 1e-10 * scale } else { 0.0 }).collect()).collect();
    let mut rhs = gradient.to_vec();
    for col in 0..m {
        let pivot = (col..m).max_by(|&r, &s| a[r][col].abs().total_cmp(&a[s][col].abs()))?;
        if a[pivot][col].abs() < 1e-300 {
            return None;
        }
        a.swap(col, pivot);
        rhs.swap(col, pivot);
        let pivot_row = a[col].clone();
        for r in col + 1..m {
            let factor = a[r][col] / pivot_row[col];
            for (c, value) in a[r].iter_mut().enumerate().skip(col) {
                *value -= factor * pivot_row[c];
            }
            rhs[r] -= factor * rhs[col];
        }
    }
    let mut d = vec![0.0; m];
    for r in (0..m).rev() {
        let tail: f64 = (r + 1..m).map(|c| a[r][c] * d[c]).sum();
        d[r] = (rhs[r] - tail) / a[r][r];
    }
    Some(d)
}

/// Maximises the concave dual over `λ ≥ 0`: projected Newton with Armijo backtracking, from λ = 0.
fn solve_dual(a: &Approximation, m: usize) -> Vec<f64> {
    let mut lambda = vec![0.0; m];
    if m == 0 {
        return lambda;
    }
    let scale = a.b.iter().map(|b| b.abs()).fold(1.0, f64::max);
    let (mut value, mut gradient, mut hessian) = dual(a, &lambda, m);
    for _ in 0..DUAL_MAX_ITERATIONS {
        let projected: Vec<f64> = (0..m).map(|i| if lambda[i] <= 0.0 && gradient[i] < 0.0 { 0.0 } else { gradient[i] }).collect();
        let norm = projected.iter().map(|g| g.abs()).fold(0.0, f64::max);
        if norm <= DUAL_TOLERANCE * scale {
            break;
        }
        let newton = ascent_direction(&hessian, &projected).filter(|d| d.iter().zip(&projected).map(|(d, g)| d * g).sum::<f64>() > 0.0);
        let direction = newton.unwrap_or_else(|| projected.iter().map(|g| g / norm.max(1e-300) * scale).collect());
        let mut t = 1.0;
        let mut accepted = false;
        for _ in 0..60 {
            let trial: Vec<f64> = (0..m).map(|i| (lambda[i] + t * direction[i]).max(0.0)).collect();
            let (trial_value, trial_gradient, trial_hessian) = dual(a, &trial, m);
            let progress: f64 = (0..m).map(|i| gradient[i] * (trial[i] - lambda[i])).sum();
            if trial_value >= value + 1e-4 * progress && trial != lambda {
                lambda = trial;
                value = trial_value;
                gradient = trial_gradient;
                hessian = trial_hessian;
                accepted = true;
                break;
            }
            t *= 0.5;
        }
        if !accepted {
            break;
        }
    }
    lambda
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOUNDS: Bounds = Bounds { xmin: 0.01, xmax: 3.0, move_limit: 0.5 };

    fn run(mut x: Vec<f64>, m: usize, bounds: Bounds, problem: impl Fn(&[f64]) -> (Vec<f64>, Vec<f64>, Vec<Vec<f64>>)) -> Vec<f64> {
        let mut mma = Mma::new(x.len(), m);
        for _ in 0..400 {
            let (df0, f, df) = problem(&x);
            let next = mma.step(&x, &df0, &f, &df, bounds);
            let change = next.iter().zip(&x).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
            x = next;
            if change < 1e-13 {
                break;
            }
        }
        x
    }

    /// VC-TOP-03 analogue: minimise Σ a_j / x_j subject to Σ x_j ≤ 2 → x* = 2 √a_j / Σ √a_k = [0.2, 0.4, 0.6, 0.8].
    #[test]
    fn separable_problem_reaches_the_lagrange_optimum() {
        let a = [1.0, 4.0, 9.0, 16.0];
        let x = run(vec![0.5; 4], 1, Bounds { xmin: 0.01, xmax: 1.0, move_limit: 0.2 }, |x| {
            let df0 = a.iter().zip(x).map(|(a, x)| -a / (x * x)).collect();
            (df0, vec![x.iter().sum::<f64>() - 2.0], vec![vec![1.0; 4]])
        });
        for (value, expected) in x.iter().zip([0.2, 0.4, 0.6, 0.8]) {
            assert!((value - expected).abs() < 1e-6, "{x:?}");
        }
    }

    /// Two active constraints with a known KKT point: min x1 + x2 s.t. 1/x1 ≤ 1, 1/x2 ≤ 2 → x* = (1, 0.5), λ* = (1, 0.25).
    #[test]
    fn two_active_constraints_give_the_kkt_point() {
        let x = run(vec![2.0, 2.0], 2, BOUNDS, |x| {
            (
                vec![1.0, 1.0],
                vec![1.0 / x[0] - 1.0, 1.0 / x[1] - 2.0],
                vec![vec![-1.0 / (x[0] * x[0]), 0.0], vec![0.0, -1.0 / (x[1] * x[1])]],
            )
        });
        assert!((x[0] - 1.0).abs() < 1e-7 && (x[1] - 0.5).abs() < 1e-7, "{x:?}");
    }

    /// A constraint that is inactive at the optimum leaves it where the unconstrained run ends: min (x1 − 0.3)² + (x2 − 0.7)²
    /// s.t. x1 + x2 ≤ 5. Plain MMA (no GCMMA inner loop) homes in on a free stationary point only to the asymptote floor,
    /// 0.01 (xmax − xmin): the approximation's minimiser sits near the descent-side asymptote whatever the gradient's size, so
    /// the iterates settle into a two-cycle of that width around the optimum (Svanberg 2002 motivates GCMMA with it).
    #[test]
    fn an_inactive_constraint_does_not_move_the_optimum() {
        let objective = |x: &[f64]| vec![2.0 * (x[0] - 0.3), 2.0 * (x[1] - 0.7)];
        let constrained = run(vec![2.5, 2.5], 1, BOUNDS, |x| (objective(x), vec![x[0] + x[1] - 5.0], vec![vec![1.0, 1.0]]));
        let free = run(vec![2.5, 2.5], 0, BOUNDS, |x| (objective(x), vec![], vec![]));
        let floor = 0.01 * (BOUNDS.xmax - BOUNDS.xmin);
        for x in [&constrained, &free] {
            assert!((x[0] - 0.3).abs() <= floor && (x[1] - 0.7).abs() <= floor, "{x:?}");
        }
    }

    /// Bounds and the move limit are honoured, and a restored state continues bit for bit.
    #[test]
    fn moves_are_limited_and_the_state_round_trips() {
        let problem = |x: &[f64]| (vec![-1.0 / (x[0] * x[0]), -1.0], vec![x[0] + x[1] - 1.0], vec![vec![1.0, 1.0]]);
        let bounds = Bounds { xmin: 0.0, xmax: 1.0, move_limit: 0.1 };
        let mut mma = Mma::new(2, 1);
        let mut x = vec![0.5, 0.5];
        for _ in 0..3 {
            let (df0, f, df) = problem(&x);
            let next = mma.step(&x, &df0, &f, &df, bounds);
            for (a, b) in next.iter().zip(&x) {
                assert!((a - b).abs() <= 0.1 + 1e-12 && (0.0..=1.0).contains(a));
            }
            x = next;
        }
        let (state, iteration) = mma.state();
        assert_eq!(state.len(), 8);
        let mut restored = Mma::restore(2, 1, &state, iteration).unwrap();
        let (df0, f, df) = problem(&x);
        let from_restored = restored.step(&x, &df0, &f, &df, bounds);
        let from_original = mma.step(&x, &df0, &f, &df, bounds);
        assert_eq!(from_restored, from_original);
        assert!(Mma::restore(2, 1, &state[..7], iteration).is_none());
    }

    #[test]
    fn the_dual_newton_solver_handles_a_zero_constraint_count() {
        let mut mma = Mma::new(2, 0);
        let x = mma.step(&[0.5, 0.5], &[1.0, -1.0], &[], &[], Bounds { xmin: 0.0, xmax: 1.0, move_limit: 0.2 });
        assert!(x[0] < 0.5 && x[1] > 0.5);
    }
}
