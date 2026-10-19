//! FE stress measures of a superposed nodal history, a port of `packages/domain-cae/src/fatigue/feStress.ts` (same operations in the same
//! order, only + - * / and square roots, so every value is bit-identical): signed von Mises signed by an invariant test (no eigenvalues),
//! max principal by Newton on the deviatoric cubic with cyclic Jacobi near a double root, or one component.

use serde::Deserialize;

/// Stress tensor `[Sxx, Syy, Szz, Sxy, Syz, Szx]` in MPa.
pub type Tensor = [f64; 6];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Measure {
    SignedVonMises,
    MaxPrincipal,
    Component { index: usize },
}

const SWEEPS: usize = 60;
const PAIRS: [(usize, usize); 3] = [(0, 1), (0, 2), (1, 2)];

fn js_sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

/// Largest and smallest principal stress (cyclic Jacobi, same rotations and stop rule as the TypeScript).
#[allow(clippy::needless_range_loop)]
pub fn principal_extremes(s: &Tensor) -> (f64, f64) {
    let mut a = [[s[0], s[3], s[5]], [s[3], s[1], s[4]], [s[5], s[4], s[2]]];
    let [xx, yy, zz, xy, yz, zx] = *s;
    let scale_squared = xx * xx + yy * yy + zz * zz + xy * xy + zx * zx + yz * yz;
    for _ in 0..SWEEPS {
        let (a01, a02, a12) = (a[0][1], a[0][2], a[1][2]);
        if a01 * a01 + a02 * a02 + a12 * a12 <= 1e-32 * scale_squared {
            break;
        }
        for (p, q) in PAIRS {
            let apq = a[p][q];
            if apq == 0.0 {
                continue;
            }
            let theta = (a[q][q] - a[p][p]) / (2.0 * apq);
            let signed = if theta == 0.0 || theta.is_nan() { 1.0 } else { theta };
            let t = js_sign(signed) / (theta.abs() + (theta * theta + 1.0).sqrt());
            let c = 1.0 / (t * t + 1.0).sqrt();
            let sn = t * c;
            for row in &mut a {
                let (akp, akq) = (row[p], row[q]);
                row[p] = c * akp - sn * akq;
                row[q] = sn * akp + c * akq;
            }
            for k in 0..3 {
                let (apk, aqk) = (a[p][k], a[q][k]);
                a[p][k] = c * apk - sn * aqk;
                a[q][k] = sn * apk + c * aqk;
            }
        }
    }
    let values = [a[0][0], a[1][1], a[2][2]];
    let mut high = values[0];
    let mut low = values[0];
    for &value in &values[1..] {
        if value > high {
            high = value;
        }
        if value < low {
            low = value;
        }
    }
    (high, low)
}

/// von Mises equivalent, same expression order as `results/fields.ts`.
pub fn von_mises(s: &Tensor) -> f64 {
    let [xx, yy, zz, xy, yz, zx] = *s;
    (0.5 * ((xx - yy) * (xx - yy) + (yy - zz) * (yy - zz) + (zz - xx) * (zz - xx)) + 3.0 * (xy * xy + yz * yz + zx * zx)).sqrt()
}

/// q'(s1) / J2 below which the largest root of the deviatoric cubic is ill-conditioned and Jacobi decides (`DEGENERATE_GAP` in TS).
const DEGENERATE_GAP: f64 = 1e-2;
const NEWTON_STEPS: usize = 100;

/// Largest principal stress: mean + largest root of t^3 - J2 t - J3 by Newton from 2 sqrt(J2 / 3) (monotone), Jacobi near a double root.
/// The negated comparisons are the TS ones: a NaN step (0 / 0 at a double root) stops the iteration and selects Jacobi.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn max_principal(s: &Tensor) -> f64 {
    let [xx, yy, zz, xy, yz, zx] = *s;
    let mean = (xx + yy + zz) / 3.0;
    let dx = xx - mean;
    let dy = yy - mean;
    let dz = zz - mean;
    let j2 = (dx * dx + dy * dy + dz * dz) / 2.0 + (xy * xy + yz * yz + zx * zx);
    let j3 = dx * (dy * dz - yz * yz) - xy * (xy * dz - yz * zx) + zx * (xy * yz - dy * zx);
    let mut root = 2.0 * (j2 / 3.0).sqrt();
    for _ in 0..NEWTON_STEPS {
        let next = root - ((root * root - j2) * root - j3) / (3.0 * root * root - j2);
        if !(next < root) {
            break;
        }
        root = next;
    }
    if !(3.0 * root * root - j2 >= DEGENERATE_GAP * j2) || j2 == 0.0 {
        return principal_extremes(s).0;
    }
    mean + root
}

/// Signed von Mises: + when s1 + s3 = I1 - s2 >= 0 (ties +); the sign of I1 when |2 I1| > vM, else the sign of -(I1 I2 - I3).
/// Same decisions as the TS early returns, evaluated without branches so the per-step loop vectorises (IEEE ops lane by lane: same bits).
#[inline(always)]
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn signed_von_mises(s: &Tensor) -> f64 {
    let magnitude = von_mises(s);
    let [xx, yy, zz, xy, yz, zx] = *s;
    let i1 = xx + yy + zz;
    let i2 = xx * yy + yy * zz + zz * xx - xy * xy - yz * yz - zx * zx;
    let i3 = xx * (yy * zz - yz * yz) - xy * (xy * zz - yz * zx) + zx * (xy * yz - yy * zx);
    let positive = (magnitude == 0.0) | (2.0 * i1 > magnitude) | (!(2.0 * i1 < -magnitude) & (i1 * i2 - i3 <= 0.0));
    if positive {
        magnitude
    } else {
        -magnitude
    }
}

/// Scalar of `measure` for one tensor.
pub fn measure_of(s: &Tensor, measure: Measure) -> f64 {
    match measure {
        Measure::Component { index } => s.get(index).copied().unwrap_or(f64::NAN),
        Measure::MaxPrincipal => max_principal(s),
        Measure::SignedVonMises => signed_von_mises(s),
    }
}

/// The measure applied per step (monomorphised into each series loop).
trait Scalar: Copy {
    fn of(self, tensor: &Tensor) -> f64;
}

#[derive(Clone, Copy)]
struct SignedVonMisesOf;
impl Scalar for SignedVonMisesOf {
    #[inline(always)]
    fn of(self, tensor: &Tensor) -> f64 {
        signed_von_mises(tensor)
    }
}

#[derive(Clone, Copy)]
struct MaxPrincipalOf;
impl Scalar for MaxPrincipalOf {
    #[inline(always)]
    fn of(self, tensor: &Tensor) -> f64 {
        max_principal(tensor)
    }
}

#[derive(Clone, Copy)]
struct ComponentOf(usize);
impl Scalar for ComponentOf {
    #[inline(always)]
    fn of(self, tensor: &Tensor) -> f64 {
        tensor.get(self.0).copied().unwrap_or(f64::NAN)
    }
}

/// K load cases known at compile time: the superposition unrolls and the step loop is straight-line (vectorisable).
fn series_of<const K: usize, S: Scalar>(tensors: &[Tensor], histories: &[Vec<f64>], scalar: S, out: &mut [f64]) {
    let steps = out.len();
    let h: [&[f64]; K] = std::array::from_fn(|k| &histories[k][..steps]);
    let s: [Tensor; K] = std::array::from_fn(|k| tensors[k]);
    for (t, value) in out.iter_mut().enumerate() {
        let mut tensor = [0.0f64; 6];
        for k in 0..K {
            let factor = h[k][t];
            for c in 0..6 {
                tensor[c] += factor * s[k][c];
            }
        }
        *value = scalar.of(&tensor);
    }
}

/// Any number of load cases (k in order, from +0.0 like the TS accumulator).
fn series_any<S: Scalar>(tensors: &[Tensor], histories: &[Vec<f64>], scalar: S, out: &mut [f64]) {
    for (t, value) in out.iter_mut().enumerate() {
        let mut tensor = [0.0f64; 6];
        for (history, s) in histories.iter().zip(tensors) {
            let factor = history[t];
            for c in 0..6 {
                tensor[c] += factor * s[c];
            }
        }
        *value = scalar.of(&tensor);
    }
}

fn series_with<S: Scalar>(tensors: &[Tensor], histories: &[Vec<f64>], scalar: S, out: &mut [f64]) {
    match histories.len().min(tensors.len()) {
        1 => series_of::<1, S>(tensors, histories, scalar, out),
        2 => series_of::<2, S>(tensors, histories, scalar, out),
        3 => series_of::<3, S>(tensors, histories, scalar, out),
        4 => series_of::<4, S>(tensors, histories, scalar, out),
        _ => series_any(tensors, histories, scalar, out),
    }
}

/// Scalar history of one node: sigma(t) = sum_k histories[k][t] * tensors[k] (k in order, from 0), then the measure; written into `out`
/// (resized only when the length changes: every value is overwritten, no per-step allocation).
pub fn node_series(tensors: &[Tensor], histories: &[Vec<f64>], steps: usize, measure: Measure, out: &mut Vec<f64>) {
    out.resize(steps, 0.0);
    match measure {
        Measure::SignedVonMises => series_with(tensors, histories, SignedVonMisesOf, out),
        Measure::MaxPrincipal => series_with(tensors, histories, MaxPrincipalOf, out),
        Measure::Component { index } => series_with(tensors, histories, ComponentOf(index), out),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn principal_values_of_simple_states() {
        assert_eq!(principal_extremes(&[100.0, 0.0, 0.0, 0.0, 0.0, 0.0]), (100.0, 0.0));
        assert_eq!(principal_extremes(&[0.0; 6]), (0.0, 0.0));
        let (high, low) = principal_extremes(&[0.0, 0.0, 0.0, 50.0, 0.0, 0.0]);
        assert!((high - 50.0).abs() < 1e-12 && (low + 50.0).abs() < 1e-12);
    }

    #[test]
    fn signed_von_mises_follows_the_dominant_principal() {
        assert_eq!(measure_of(&[-100.0, 0.0, 0.0, 0.0, 0.0, 0.0], Measure::SignedVonMises), -100.0);
        assert_eq!(measure_of(&[100.0, 0.0, 0.0, 0.0, 0.0, 0.0], Measure::SignedVonMises), 100.0);
        assert_eq!(measure_of(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], Measure::Component { index: 4 }), 5.0);
        assert!(measure_of(&[1.0; 6], Measure::Component { index: 9 }).is_nan());
    }

    #[test]
    fn superposes_load_cases_per_step() {
        let mut out = Vec::new();
        let tensors = [[100.0, 0.0, 0.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 0.0, 0.0, 10.0]];
        node_series(&tensors, &[vec![1.0, -1.0], vec![0.0, 2.0]], 2, Measure::Component { index: 0 }, &mut out);
        assert_eq!(out, [100.0, -100.0]);
        let many = [[1.0, 0.0, 0.0, 0.0, 0.0, 0.0]; 5];
        let factors: Vec<Vec<f64>> = (1..=5).map(|k| vec![f64::from(k), -f64::from(k)]).collect();
        node_series(&many, &factors, 2, Measure::SignedVonMises, &mut out);
        assert_eq!(out, [15.0, -15.0]);
        node_series(&many, &factors[..1], 2, Measure::MaxPrincipal, &mut out);
        assert_eq!(out, [1.0, 0.0]);
    }

    #[test]
    fn max_principal_takes_jacobi_at_double_roots_and_newton_elsewhere() {
        assert_eq!(max_principal(&[-100.0, 0.0, 0.0, 0.0, 0.0, 0.0]), 0.0);
        assert_eq!(max_principal(&[100.0, 100.0, 0.0, 0.0, 0.0, 0.0]), 100.0);
        assert_eq!(max_principal(&[70.0, 70.0, 70.0, 0.0, 0.0, 0.0]), 70.0);
        assert_eq!(max_principal(&[0.0; 6]), 0.0);
        let tensor = [10.0, 20.0, 30.0, 5.0, 6.0, 7.0];
        assert!((max_principal(&tensor) - principal_extremes(&tensor).0).abs() < 1e-12);
    }

    #[test]
    fn signed_von_mises_signs_by_invariants() {
        assert_eq!(signed_von_mises(&[-70.0, -70.0, -70.0, 0.0, 0.0, 0.0]), 0.0);
        assert_eq!(signed_von_mises(&[-100.0, -100.0, 0.0, 0.0, 0.0, 0.0]), -100.0);
        assert!(signed_von_mises(&[0.0, 0.0, 0.0, 50.0, 0.0, 0.0]) > 0.0);
        assert!(signed_von_mises(&[30.0, -100.0, 0.0, 0.0, 0.0, 0.0]) < 0.0);
        assert!(signed_von_mises(&[100.0, -30.0, 0.0, 0.0, 0.0, 0.0]) > 0.0);
    }
}
