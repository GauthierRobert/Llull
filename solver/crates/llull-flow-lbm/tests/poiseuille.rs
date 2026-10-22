//! VC-CFD-20: plane Poiseuille flow driven by a body force between two half-way bounce-back walls (periodic in x and y). The
//! steady profile is `u(z) = g (z − z0)(z1 − z) / (2 ν)` with the walls half a cell outside the first and last fluid cells; the
//! L2 error of the profile must fall with observed order >= 1.8 over 16 / 32 / 64 cells across the channel.

use llull_flow_core::grid::Grid;
use llull_flow_lbm::cpu::CpuSolver;
use llull_flow_lbm::domain::{Domain, SOLID};
use llull_flow_lbm::kernel::Params;

/// τ = 0.8: away from the "magic" τ = ½ + √(3/16) (where half-way bounce-back reproduces the parabola to round-off) the discrete
/// slip error is O(h²), which is what the order check measures.
const NU: f64 = 0.1;

/// Relative L2 error of the steady profile at `n` cells across the channel.
fn profile_error(n: usize) -> f64 {
    let grid = Grid::covering([0.0; 3], [2.0, 2.0, (n + 2) as f64], 1.0);
    let mut domain = Domain::new(grid.clone(), [true, true, false]);
    domain.set_face(2, false, SOLID);
    domain.set_face(2, true, SOLID);
    let height = n as f64;
    let g = 0.16 * NU / (height * height);
    let params = Params { tau: 3.0 * NU + 0.5, smagorinsky: 0.0, u_in: [0.0; 3], u_wall: [0.0; 3], body_force: [g, 0.0, 0.0] };
    let mut solver = CpuSolver::<f64>::new(domain, params, |_| (1.0, [0.0; 3]));
    let diffusion_steps = ((height * height) / NU) as u64;
    let mut previous = f64::NAN;
    for _ in 0..40 {
        solver.run((diffusion_steps / 4).max(200)).unwrap();
        let centre = solver.vel()[grid.index(1, 1, n / 2 + 1)][0];
        if ((centre - previous) / centre).abs() < 1e-7 {
            break;
        }
        previous = centre;
    }
    let mut num = 0.0f64;
    let mut den = 0.0f64;
    for k in 1..=n {
        let z = k as f64 + 0.5;
        let exact = g * (z - 1.0) * (height + 1.0 - z) / (2.0 * NU);
        let computed = solver.vel()[grid.index(1, 1, k)][0];
        num += (computed - exact).powi(2);
        den += exact * exact;
    }
    (num / den).sqrt()
}

#[test]
fn poiseuille_profile_converges_at_second_order() {
    let errors: Vec<f64> = [16usize, 32, 64].iter().map(|n| profile_error(*n)).collect();
    let order = |coarse: f64, fine: f64| (coarse / fine).log2();
    let first = order(errors[0], errors[1]);
    let second = order(errors[1], errors[2]);
    eprintln!("VC-CFD-20 Poiseuille L2 errors {errors:?}, observed orders {first:.3} / {second:.3}");
    assert!(errors[0] < 0.05, "16 cells: {}", errors[0]);
    assert!(first >= 1.8, "order 16 -> 32: {first}");
    assert!(second >= 1.8, "order 32 -> 64: {second}");
}
