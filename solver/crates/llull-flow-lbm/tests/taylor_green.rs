//! VC-CFD-22: the Taylor-Green vortex decays as `exp(−2 ν k² t)`; on a 64 × 64 periodic (quasi-2D) lattice the amplitude ratio
//! at `ν k² t = 0.3948` (ν 0.01 m²/s, k 2π/m, t 1 s in the pack) must be 0.45404 within 1 %.

use llull_flow_core::grid::Grid;
use llull_flow_lbm::cpu::CpuSolver;
use llull_flow_lbm::domain::Domain;
use llull_flow_lbm::kernel::Params;
use llull_flow_lbm::lattice::CS2;

const N: usize = 64;
const NU: f64 = 0.04;
const U0: f64 = 0.02;
const STEPS: u64 = 1024;

#[test]
fn taylor_green_amplitude_decays_at_the_exact_rate() {
    let grid = Grid::covering([0.0; 3], [N as f64, N as f64, 1.0], 1.0);
    let domain = Domain::new(grid.clone(), [true; 3]);
    let k = 2.0 * std::f64::consts::PI / N as f64;
    let params = Params { tau: 3.0 * NU + 0.5, smagorinsky: 0.0, u_in: [0.0; 3], u_wall: [0.0; 3], body_force: [0.0; 3] };
    let mut solver = CpuSolver::<f64>::new(domain, params, |cell| {
        let (i, j, _) = grid.coords(cell);
        let x = k * (i as f64 + 0.5);
        let y = k * (j as f64 + 0.5);
        let u = [U0 * x.sin() * y.cos(), -U0 * x.cos() * y.sin(), 0.0];
        let rho = 1.0 + (U0 * U0 / (4.0 * CS2)) * ((2.0 * x).cos() + (2.0 * y).cos());
        (rho, u)
    });
    solver.run(STEPS).unwrap();
    let peak = solver.vel().iter().map(|u| (u[0] * u[0] + u[1] * u[1]).sqrt()).fold(0.0f64, f64::max);
    let ratio = peak / U0;
    let exponent = 2.0 * NU * k * k * STEPS as f64;
    let expected = (-exponent).exp();
    eprintln!("VC-CFD-22 Taylor-Green amplitude ratio {ratio:.5}, exact {expected:.5} (nu k^2 t = {:.4})", exponent / 2.0);
    assert!((ratio - expected).abs() / expected < 0.01, "ratio {ratio} vs {expected}");
    assert!((ratio - 0.45404).abs() / 0.45404 < 0.01, "ratio {ratio} vs the pack's 0.45404");
}
