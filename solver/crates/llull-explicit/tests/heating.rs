//! Adiabatic heating of Johnson–Cook plastic work (RS-8, PHY-19 TECHNICAL_SPEC §13.9): `Ṫ = β σ:ε̇ᵖ/(ρ c_p)` (LS-DYNA R14 Keyword
//! Manual Vol. II *MAT_107 Eq. 107.21) with the thermal softening `(1 − T*ᵐ)` of the flow stress (Theory Manual Eq. 22.15.1).
//! Synthetic test inputs (not a material): ρ = 7.85e-9 t/mm³, c_p = 4.6e8 mJ/(t·K), A = 300 MPa, β = 0.9.

use llull_explicit::material::{update, PointState};
use llull_explicit::model::{Heating, JohnsonCook, Material};

const RHO: f64 = 7.85e-9;
const CP: f64 = 4.6e8;
const BETA: f64 = 0.9;

fn material(melt_k: f64) -> Material {
    let jc = JohnsonCook { a: 300.0, b: 0.0, n: 1.0, c: 0.0, reference_rate: 1.0, m: 1.0, melt_k, transition_k: 293.0 };
    Material {
        density: RHO,
        youngs_modulus: 200_000.0,
        poisson: 0.3,
        johnson_cook: Some(jc),
        failure: None,
        heating: Some(Heating { taylor_quinney: BETA, specific_heat: CP }),
    }
}

/// Uniaxial plastic flow (isochoric rate path) for `steps` steps of 1e-5 s at unit strain rate.
fn deform(material: &Material, steps: usize) -> PointState {
    let d = [1.0, -0.5, -0.5, 0.0, 0.0, 0.0];
    let mut state = PointState { temperature: 293.0, ..PointState::default() };
    for _ in 0..steps {
        state = update(material, &state, &d, &[0.0; 3], 1e-5);
    }
    state
}

#[test]
fn temperature_rise_equals_beta_times_plastic_work_over_rho_cp() {
    // T_m far away: T* stays ~0, the flow stress stays A, the plastic work is A ε_p.
    let point = deform(&material(1e12), 3000);
    let expected = BETA * 300.0 * point.plastic_strain / (RHO * CP);
    assert!(point.plastic_strain > 0.02);
    assert!(((point.temperature - 293.0) / expected - 1.0).abs() < 1e-9, "ΔT {} vs {expected}", point.temperature - 293.0);
}

#[test]
fn linear_softening_follows_the_closed_form_exponential() {
    // m = 1: dT/dε = β A (1 − T*) / (ρ c) ⇒ T − T_r = (T_m − T_r)(1 − exp(−β A ε / (ρ c (T_m − T_r)))).
    let melt = 600.0;
    let point = deform(&material(melt), 3000);
    let span = melt - 293.0;
    let expected = span * (1.0 - (-BETA * 300.0 * point.plastic_strain / (RHO * CP * span)).exp());
    let rise = point.temperature - 293.0;
    eprintln!("softening: ΔT {rise:.4} K vs closed form {expected:.4} K at ε_p {:.4}", point.plastic_strain);
    assert!((rise / expected - 1.0).abs() < 2e-3, "explicit-in-T integration within 0.2 %");
    // The flow stress followed the temperature: von Mises = A (1 − T*).
    let vm = llull_explicit::material::von_mises(&point.stress);
    let t_star_before = (point.temperature - 293.0) / span;
    assert!((vm / (300.0 * (1.0 - t_star_before)) - 1.0).abs() < 5e-3);
}

#[test]
fn without_heating_the_point_stays_at_its_initial_temperature() {
    let isothermal = Material { heating: None, ..material(600.0) };
    let point = deform(&isothermal, 500);
    assert!(point.plastic_strain > 0.0);
    assert_eq!(point.temperature, 293.0);
}
