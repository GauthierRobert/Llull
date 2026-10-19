//! FE stress measures of a superposed nodal history, a port of `packages/domain-cae/src/fatigue/feStress.ts`: principal stresses by
//! cyclic Jacobi (square roots only, so bit-reproducible), signed von Mises, max principal or one component.

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

/// Scalar of `measure` for one tensor.
pub fn measure_of(s: &Tensor, measure: Measure) -> f64 {
    match measure {
        Measure::Component { index } => s.get(index).copied().unwrap_or(f64::NAN),
        Measure::MaxPrincipal => principal_extremes(s).0,
        Measure::SignedVonMises => {
            let (high, low) = principal_extremes(s);
            let magnitude = von_mises(s);
            if high.abs() >= low.abs() {
                magnitude
            } else {
                -magnitude
            }
        }
    }
}

/// Scalar history of one node: sigma(t) = sum_k histories[k][t] * tensors[k] (k in order, from 0), then the measure.
pub fn node_series(tensors: &[Tensor], histories: &[Vec<f64>], steps: usize, measure: Measure, out: &mut Vec<f64>) {
    out.clear();
    for t in 0..steps {
        let mut tensor = [0.0f64; 6];
        for (k, history) in histories.iter().enumerate() {
            let h = history[t];
            let s = &tensors[k];
            for c in 0..6 {
                tensor[c] += h * s[c];
            }
        }
        out.push(measure_of(&tensor, measure));
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
    }
}
