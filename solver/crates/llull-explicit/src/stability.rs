//! Element stable time step from the element's maximum eigenvalue (PHY-19 TECHNICAL_SPEC §13, decision Q10).
//!
//! Sierra/SolidMechanics 4.50 Theory Manual (SAND2018-10680) §12.3.1, Eqs. 12.13–12.16: `Δt ≤ 2/ω_max`, and "the maximum element eigenvalue
//! is an upper bound on the maximum global eigenvalue"; `ω = 2c/h` defines the effective length `h = 2c/ω` that then enters the LS-DYNA
//! bulk-viscosity form `Δt_e = h / (Q + √(Q² + c²))` (LS-DYNA R14 Theory Manual Eqs. 25.2–25.3).
//!
//! For a one-point element with lumped nodal masses `m_I` the generalised eigenproblem `K φ = ω² M φ`, `K = (1/V) Bᵀ C B`, has the same
//! non-zero eigenvalues as the 6 × 6 symmetric matrix `S = (1/V) C^½ H C^½`, `H = Σ_I B_I B_Iᵀ / m_I` (Mandel notation, `B_I` the 6 × 3
//! strain-rate operator of node I built from the unnormalised gradients). `C^½ = √(2μ) I + (√(3K) − √(2μ)) e eᵀ`, `e = (1, 1, 1, 0, 0, 0)/√3`
//! for an isotropic material. This replaces `L_e = V / A_max`, which is not a bound for one-element-thick free surfaces (measured: a free
//! 3 × 2 × 1 hex plate grows from round-off at 0.9 V/A_max/c).

use crate::model::Material;

const ROOT2: f64 = std::f64::consts::SQRT_2;

/// The 6 × 3 Mandel strain-rate operator of a node with unnormalised gradient `b`.
fn operator(b: &[f64; 3]) -> [[f64; 3]; 6] {
    let s = 1.0 / ROOT2;
    [[b[0], 0.0, 0.0], [0.0, b[1], 0.0], [0.0, 0.0, b[2]], [s * b[1], s * b[0], 0.0], [0.0, s * b[2], s * b[1]], [s * b[2], 0.0, s * b[0]]]
}

/// Largest eigenvalue of a symmetric 6 × 6 matrix (cyclic Jacobi, fixed sweep order: deterministic).
fn largest_eigenvalue(mut a: [[f64; 6]; 6]) -> f64 {
    for _ in 0..30 {
        let off: f64 = (0..6).flat_map(|i| (0..6).filter(move |&j| j != i).map(move |j| (i, j))).map(|(i, j)| a[i][j] * a[i][j]).sum();
        let diagonal: f64 = (0..6).map(|i| a[i][i] * a[i][i]).sum();
        if off <= 1e-30 * diagonal {
            break;
        }
        for p in 0..5 {
            for q in p + 1..6 {
                if a[p][q] == 0.0 {
                    continue;
                }
                let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let t = if theta == 0.0 { 1.0 } else { t };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..6 {
                    let (akp, akq) = (a[k][p], a[k][q]);
                    a[k][p] = c * akp - s * akq;
                    a[k][q] = s * akp + c * akq;
                }
                for k in 0..6 {
                    let (apk, aqk) = (a[p][k], a[q][k]);
                    a[p][k] = c * apk - s * aqk;
                    a[q][k] = s * apk + c * aqk;
                }
            }
        }
    }
    (0..6).map(|i| a[i][i]).fold(f64::NEG_INFINITY, f64::max)
}

/// ω²_max of an element with unnormalised gradients `b`, volume `volume`, lumped nodal masses `masses` and elastic `material`.
pub fn omega_squared(b: &[[f64; 3]], volume: f64, masses: &[f64], material: &Material) -> f64 {
    let mut h = [[0.0; 6]; 6];
    for (gradient, &mass) in b.iter().zip(masses) {
        let op = operator(gradient);
        for (i, row) in h.iter_mut().enumerate() {
            for (j, entry) in row.iter_mut().enumerate() {
                *entry += (0..3).map(|k| op[i][k] * op[j][k]).sum::<f64>() / mass;
            }
        }
    }
    let shear = (2.0 * material.shear()).sqrt();
    let bulk = (3.0 * material.bulk()).sqrt();
    let root = |i: usize, j: usize| {
        let volumetric = if i < 3 && j < 3 { (bulk - shear) / 3.0 } else { 0.0 };
        volumetric + if i == j { shear } else { 0.0 }
    };
    let mut ch = [[0.0; 6]; 6];
    for i in 0..6 {
        for j in 0..6 {
            ch[i][j] = (0..6).map(|k| root(i, k) * h[k][j]).sum();
        }
    }
    let mut s = [[0.0; 6]; 6];
    for i in 0..6 {
        for j in 0..6 {
            s[i][j] = (0..6).map(|k| ch[i][k] * root(k, j)).sum::<f64>() / volume;
        }
    }
    largest_eigenvalue(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hex8;

    #[test]
    fn the_element_bound_dominates_the_breathing_and_stretching_modes_of_a_free_cube() {
        let material = Material { density: 1.0, youngs_modulus: 1.0, poisson: 0.3, johnson_cook: None, failure: None, heating: None };
        let x = [[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.], [0., 0., 1.], [1., 0., 1.], [1., 1., 1.], [0., 1., 1.]];
        let (b, volume) = hex8::gradients(&x);
        let masses = [0.125; 8];
        let omega2 = omega_squared(&b, volume, &masses, &material);
        // Rayleigh quotient of any mode is a lower bound of ω²_max: breathing v_I = x_I − ½ and stretching v_I = (x_I − ½, 0, 0).
        let rayleigh = |v: &dyn Fn(usize) -> [f64; 3]| {
            let mut strain = [0.0; 6];
            for node in 0..8 {
                let op = operator(&b[node]);
                let vel = v(node);
                for (i, value) in strain.iter_mut().enumerate() {
                    *value += (0..3).map(|k| op[i][k] * vel[k]).sum::<f64>() / volume;
                }
            }
            let (lambda, mu) = (material.lambda(), material.shear());
            let trace = strain[0] + strain[1] + strain[2];
            let energy = volume * (lambda * trace * trace + 2.0 * mu * strain.iter().map(|e| e * e).sum::<f64>());
            let kinetic: f64 = (0..8).map(|node| masses[node] * v(node).iter().map(|c| c * c).sum::<f64>()).sum();
            energy / kinetic
        };
        let breathing = rayleigh(&|node| x[node].map(|c| c - 0.5));
        let stretching = rayleigh(&|node| [x[node][0] - 0.5, 0.0, 0.0]);
        assert!(omega2 >= breathing * (1.0 - 1e-12) && omega2 >= stretching * (1.0 - 1e-12));
        // The old L_e/c estimate gives ω = 2c/L_e = 2c: the free cube's bound is higher, which is why that estimate went unstable.
        let c2 = material.dilatational_speed(1.0).powi(2);
        assert!(omega2 > 4.0 * c2);
    }
}
