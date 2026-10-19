//! Stress update of one integration point: Jaumann rotation, hypoelastic increment, J2 radial return with Johnson–Cook flow stress.
//!
//! Sources (PHY-19 TECHNICAL_SPEC §13):
//! - Jaumann rate: LS-DYNA R14 Theory Manual §21.1 Eqs. 21.3–21.7 (`σ^{n+1} = σ^n + r^n + Δt C:D`, `r_ij = (σ_ip ω_pj + σ_jp ω_pi) Δt`,
//!   rotation first, then the constitutive increment).
//! - Radial return: LS-DYNA R14 Theory Manual §22.3 Eqs. 22.3.14–22.3.16 (Krieg & Key 1976): trial deviator, yield check on
//!   `σ̄* = √(3/2 s*:s*)`, `s^{n+1} = (σ_y^{n+1}/σ̄*) s*`, `σ̄* − 3G Δε_p = σ_y^{n+1}`. With Johnson–Cook hardening and rate terms the scalar
//!   equation is solved by bisection (strictly decreasing in Δε_p), so no linearisation error is left.
//! - Johnson–Cook flow stress: LS-DYNA R14 Theory Manual §22.15 Eq. 22.15.1, rate term clamped at the reference rate (TR-EXP-20); the
//!   plastic strain rate `Δε_p/Δt` is used (LS-DYNA *MAT_015 VP = 1). Isothermal at the transition temperature (T* = 0).

use crate::model::Material;

/// Symmetric tensor `[xx, yy, zz, xy, yz, zx]`.
pub type Sym = [f64; 6];

/// State carried by an element between steps.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct PointState {
    pub stress: Sym,
    pub plastic_strain: f64,
}

/// Rate of deformation `D` and spin `ω` of a velocity gradient `L`.
pub fn split(l: &[[f64; 3]; 3]) -> (Sym, [f64; 3]) {
    let d = [l[0][0], l[1][1], l[2][2], 0.5 * (l[0][1] + l[1][0]), 0.5 * (l[1][2] + l[2][1]), 0.5 * (l[2][0] + l[0][2])];
    // ω_xy, ω_yz, ω_zx with ω_ij = ½(L_ij − L_ji).
    let w = [0.5 * (l[0][1] - l[1][0]), 0.5 * (l[1][2] - l[2][1]), 0.5 * (l[2][0] - l[0][2])];
    (d, w)
}

fn full(s: &Sym) -> [[f64; 3]; 3] {
    [[s[0], s[3], s[5]], [s[3], s[1], s[4]], [s[5], s[4], s[2]]]
}

fn spin_matrix(w: &[f64; 3]) -> [[f64; 3]; 3] {
    [[0.0, w[0], -w[2]], [-w[0], 0.0, w[1]], [w[2], -w[1], 0.0]]
}

/// Jaumann rotation increment `r_ij = (σ_ip ω_pj + σ_jp ω_pi) Δt` added to `σ`.
fn rotate(stress: &Sym, w: &[f64; 3], dt: f64) -> Sym {
    let s = full(stress);
    let o = spin_matrix(w);
    let r = |i: usize, j: usize| (0..3).map(|p| s[i][p] * o[p][j] + s[j][p] * o[p][i]).sum::<f64>() * dt;
    [stress[0] + r(0, 0), stress[1] + r(1, 1), stress[2] + r(2, 2), stress[3] + r(0, 1), stress[4] + r(1, 2), stress[5] + r(2, 0)]
}

/// Von Mises equivalent stress.
pub fn von_mises(s: &Sym) -> f64 {
    let p = (s[0] + s[1] + s[2]) / 3.0;
    let (a, b, c) = (s[0] - p, s[1] - p, s[2] - p);
    (1.5 * (a * a + b * b + c * c + 2.0 * (s[3] * s[3] + s[4] * s[4] + s[5] * s[5]))).sqrt()
}

/// Updated state after a step of length `dt` with rate of deformation `d` and spin `w`.
pub fn update(material: &Material, state: &PointState, d: &Sym, w: &[f64; 3], dt: f64) -> PointState {
    let rotated = rotate(&state.stress, w, dt);
    let lambda = material.lambda();
    let mu = material.shear();
    let trace = d[0] + d[1] + d[2];
    let mut trial = rotated;
    for i in 0..3 {
        trial[i] += dt * (lambda * trace + 2.0 * mu * d[i]);
    }
    for i in 3..6 {
        trial[i] += dt * 2.0 * mu * d[i];
    }
    let Some(jc) = material.johnson_cook else {
        return PointState { stress: trial, plastic_strain: state.plastic_strain };
    };
    let equivalent = von_mises(&trial);
    let eps = state.plastic_strain;
    if equivalent <= jc.flow_stress(eps, 0.0) {
        return PointState { stress: trial, plastic_strain: eps };
    }
    let residual = |increment: f64| equivalent - 3.0 * mu * increment - jc.flow_stress(eps + increment, increment / dt);
    let (mut low, mut high) = (0.0, equivalent / (3.0 * mu));
    for _ in 0..200 {
        let middle = 0.5 * (low + high);
        if middle <= low || middle >= high {
            break;
        }
        if residual(middle) > 0.0 {
            low = middle;
        } else {
            high = middle;
        }
    }
    let increment = 0.5 * (low + high);
    let yield_stress = equivalent - 3.0 * mu * increment;
    let pressure = (trial[0] + trial[1] + trial[2]) / 3.0;
    let scale = yield_stress / equivalent;
    let stress = [
        pressure + (trial[0] - pressure) * scale,
        pressure + (trial[1] - pressure) * scale,
        pressure + (trial[2] - pressure) * scale,
        trial[3] * scale,
        trial[4] * scale,
        trial[5] * scale,
    ];
    PointState { stress, plastic_strain: eps + increment }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::JohnsonCook;

    fn steel(jc: Option<JohnsonCook>) -> Material {
        Material { density: 7.85e-9, youngs_modulus: 200_000.0, poisson: 0.3, johnson_cook: jc }
    }

    #[test]
    fn a_pure_spin_rotates_a_uniaxial_stress_without_changing_its_invariants() {
        let mut state = PointState { stress: [100.0, 0.0, 0.0, 0.0, 0.0, 0.0], plastic_strain: 0.0 };
        let w = [1.0, 0.0, 0.0];
        for _ in 0..1000 {
            state = update(&steel(None), &state, &[0.0; 6], &w, 1e-5);
        }
        // after 0.01 rad about z the stress is still ~uniaxial 100: σ_xy ≈ −100 · 0.01 (sign by the ω convention) and |σ| conserved to O(θ²).
        assert!((von_mises(&state.stress) - 100.0).abs() < 1e-2);
        assert!((state.stress[3].abs() - 1.0).abs() < 1e-2);
    }

    #[test]
    fn radial_return_lands_on_the_johnson_cook_surface() {
        let jc = JohnsonCook { a: 300.0, b: 500.0, n: 0.5, c: 0.0, reference_rate: 1.0, m: 1.0, melt_k: 1800.0, transition_k: 293.0 };
        let material = steel(Some(jc));
        let d = [1.0, -0.5, -0.5, 0.0, 0.0, 0.0];
        let mut state = PointState::default();
        for _ in 0..100 {
            state = update(&material, &state, &d, &[0.0; 3], 1e-4);
        }
        assert!(state.plastic_strain > 0.0);
        let flow = jc.flow_stress(state.plastic_strain, 0.0);
        assert!((von_mises(&state.stress) - flow).abs() < 1e-8 * flow);
    }
}
