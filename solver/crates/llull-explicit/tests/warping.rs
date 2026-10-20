//! Warping stiffness of the Belytschko–Tsay shell (RS-8, PHY-19 TECHNICAL_SPEC §13.9): the Belytschko–Leviathan full projection
//! (LS-DYNA R14 Theory Manual §11.6 Eq. 11.28; *CONTROL_SHELL BWC = 1, PROJ = 1), with and without.
//! - The twisted beam of LS-DYNA Theory Manual Fig. 9.2 / MacNeal & Harder (1985): L 12, b 1.1, t 0.32, 90° twist, E 29e6, ν 0.22,
//!   12 × 2 shells, root clamped, suddenly applied uniform load `w` along the tip width (gravity). Closed form (Euler–Bernoulli with
//!   Timoshenko shear, unit-load method over the rotating section): static work `W_s = ∫ w u dx = w²/(4E) ∫ (L−s)⁴ c(s) ds +
//!   w² L³/(3 κ G A)` with the section compliance along the load `c = cos²θ/I_weak + sin²θ/I_strong`, θ = 90° s/L. Under a sudden
//!   constant load the undamped response oscillates about the static one, so the time mean of the external work over many periods
//!   is `W_s`. (The same integration for a tip load gives 5.426e-3 against the MacNeal–Harder 5.424e-3, a check of the closed form.)
//!   Out of plane (load along the tip normal) the section compliance swaps: `c = sin²θ/I_weak + cos²θ/I_strong` (tip load: 1.746e-3 vs
//!   MacNeal–Harder 1.754e-3).
//! - A warped element in rigid rotation: the plain element makes membrane hourglass forces, the projected one none.
//!   Synthetic density 7.3e-4 (consistent units, not a material).

mod common;

use common::{controls, steel};
use llull_explicit::model::{Material, Model};
use llull_explicit::shell::{step, ShellState};
use llull_explicit::solver::run;

const L: f64 = 12.0;
const B: f64 = 1.1;
const T: f64 = 0.32;
const E: f64 = 29e6;
const NU: f64 = 0.22;
const RHO: f64 = 7.3e-4;
const G_LOAD: f64 = 1e4;

fn diagonal_normal(x: &[[f64; 3]; 4]) -> [f64; 3] {
    let d1: [f64; 3] = std::array::from_fn(|i| x[2][i] - x[0][i]);
    let d2: [f64; 3] = std::array::from_fn(|i| x[3][i] - x[1][i]);
    let n = [d1[1] * d2[2] - d1[2] * d2[1], d1[2] * d2[0] - d1[0] * d2[2], d1[0] * d2[1] - d1[1] * d2[0]];
    let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    n.map(|c| c / l)
}

fn material() -> Material {
    Material { density: RHO, youngs_modulus: E, poisson: NU, ..steel(NU, None) }
}

/// 12 × 2 shells, the section at x rotated by θ = 90° x/L about the axis: width along y at the root, along z at the tip.
/// `in_plane`: the load along the tip width (z); otherwise along the tip normal (y).
fn twisted_beam(warping: bool, in_plane: bool) -> Model {
    let (nx, ny) = (12, 2);
    let mut coordinates = Vec::new();
    for j in 0..=ny {
        for i in 0..=nx {
            let x = L * i as f64 / nx as f64;
            let s = B * (j as f64 / ny as f64 - 0.5);
            let theta = std::f64::consts::FRAC_PI_2 * x / L;
            coordinates.extend_from_slice(&[x, s * theta.cos(), s * theta.sin()]);
        }
    }
    let node = |i: usize, j: usize| (i + (nx + 1) * j) as u32;
    let mut shell4 = Vec::new();
    for j in 0..ny {
        for i in 0..nx {
            shell4.extend_from_slice(&[node(i, j), node(i + 1, j), node(i + 1, j + 1), node(i, j + 1)]);
        }
    }
    let nodes = coordinates.len() / 3;
    let root: Vec<bool> = (0..nodes).map(|n| coordinates[3 * n] == 0.0).collect();
    let mut model = common::model(coordinates, vec![], vec![], material(), [0.0; 3], controls(0.1, 2e-5));
    model.gravity = if in_plane { [0.0, 0.0, G_LOAD] } else { [0.0, G_LOAD, 0.0] };
    model.shell4 = shell4;
    model.shell_thickness = vec![T; nx * ny];
    model.element_material = vec![0; nx * ny];
    model.initial_velocity = vec![0.0; 3 * nodes];
    model.fixed = (0..3 * nodes).map(|k| root[k / 3]).collect();
    model.fixed_rotation = model.fixed.clone();
    model.shell_warping = warping;
    model
}

fn static_work(in_plane: bool) -> f64 {
    let w = RHO * G_LOAD * B * T;
    let (i_strong, i_weak) = (T * B.powi(3) / 12.0, B * T.powi(3) / 12.0);
    let n = 20_000;
    let bending: f64 = (0..n)
        .map(|k| {
            let s = (k as f64 + 0.5) * L / n as f64;
            let theta = std::f64::consts::FRAC_PI_2 * s / L;
            let (weak, strong) = if in_plane { (theta.cos(), theta.sin()) } else { (theta.sin(), theta.cos()) };
            (L - s).powi(4) * (weak.powi(2) / i_weak + strong.powi(2) / i_strong) * L / n as f64
        })
        .sum();
    let shear_modulus = E / (2.0 * (1.0 + NU));
    w * w / (4.0 * E) * bending + w * w * L.powi(3) / (3.0 * 5.0 / 6.0 * shear_modulus * B * T)
}

/// Time mean of the external work over the run (about 20 periods of the first mode: the bias of a partial period is ~1/(2π·20) of the
/// oscillation; a window between deep minima is biased when several modes are excited).
fn mean_work(warping: bool, in_plane: bool) -> f64 {
    let outcome = run(&twisted_beam(warping, in_plane), &mut |_| {}).expect("the run succeeds");
    assert!(outcome.normal, "{}", outcome.message);
    let work: Vec<f64> = outcome.energy.iter().map(|row| row.external_work).collect();
    work.iter().sum::<f64>() / work.len() as f64
}

#[test]
fn twisted_beam_matches_beam_theory_with_the_bwc_shell() {
    // Belytschko–Wong–Chiang (projection, fibers, edge shear) against the plain Belytschko–Tsay element, both load directions.
    for in_plane in [true, false] {
        let reference = static_work(in_plane);
        let with = mean_work(true, in_plane);
        let without = mean_work(false, in_plane);
        eprintln!(
            "twisted beam ({}): static work {reference:.6e}, BWC {with:.6e} ({:+.2} %), plain BT {without:.6e} ({:+.2} %)",
            if in_plane { "load along the tip width" } else { "load along the tip normal" },
            100.0 * (with / reference - 1.0),
            100.0 * (without / reference - 1.0)
        );
        assert!((with / reference - 1.0).abs() < 0.05, "BWC within 5 %");
        if in_plane {
            assert!((without / reference - 1.0).abs() > 4.0 * (with / reference - 1.0).abs(), "the plain element is far off");
        }
    }
}

#[test]
fn a_warped_element_in_rigid_rotation_is_force_free_only_with_the_projection() {
    let x0 = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.1], [1.0, 1.0, 0.0], [0.0, 1.0, 0.1]];
    let omega = [100.0, 0.0, 0.0];
    let v = x0.map(|p| [omega[1] * p[2] - omega[2] * p[1], omega[2] * p[0] - omega[0] * p[2], omega[0] * p[1] - omega[1] * p[0]]);
    let dt = 1e-7;
    let x1: [[f64; 3]; 4] = std::array::from_fn(|k| std::array::from_fn(|i| x0[k][i] + dt * v[k][i]));
    let normals = [diagonal_normal(&x0); 4];
    let largest = |warping: bool| {
        let mut state = ShellState::new(2, 293.0);
        let mut peak = 0.0_f64;
        for _ in 0..10 {
            let result = step(&steel(0.3, None), 0.05, &state, &x0, &x1, &v, &[omega; 4], dt, warping.then_some(&normals));
            peak = peak.max(result.forces.iter().flatten().map(|f| f.abs()).fold(0.0, f64::max));
            state = result.state;
        }
        peak
    };
    let (plain, projected) = (largest(false), largest(true));
    eprintln!("warped rigid rotation: plain {plain:e}, projected {projected:e}");
    assert!(plain > 1e-3, "the plain warped element strains under rigid rotation");
    // The residual is the O(θ²) stretch of straight-line nodal paths over a step (θ = 1e-5).
    assert!(projected < 1e-3 * plain, "the projection removes it");
}
