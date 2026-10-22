//! Moving-wall bounce-back (the `moving_ground` face): plane Couette flow between a wall sliding along x at `u_w` (z = 0) and a
//! wall at rest (z = H), periodic in x and y. The steady profile is linear, `u(z) = u_w (z_top − z) / H` with the half-way walls
//! half a cell outside the first and last fluid cells, and the wall velocity term must not create or destroy mass.

use llull_flow_core::grid::Grid;
use llull_flow_lbm::cpu::CpuSolver;
use llull_flow_lbm::domain::{Domain, MOVING_WALL, SOLID};
use llull_flow_lbm::kernel::Params;

#[test]
fn couette_profile_is_linear_and_mass_is_conserved() {
    let n = 24usize;
    let grid = Grid::covering([0.0; 3], [2.0, 2.0, (n + 2) as f64], 1.0);
    let mut domain = Domain::new(grid.clone(), [true, true, false]);
    domain.set_face(2, false, MOVING_WALL);
    domain.set_face(2, true, SOLID);
    let u_w = 0.04f64;
    let nu = 0.1f64;
    let params = Params { tau: 3.0 * nu + 0.5, smagorinsky: 0.0, u_in: [0.0; 3], u_wall: [u_w, 0.0, 0.0], body_force: [0.0; 3] };
    let mut solver = CpuSolver::<f64>::new(domain, params, |_| (1.0, [0.0; 3]));
    let mass_before: f64 = solver.rho().iter().sum();
    solver.run(((n * n) as f64 / nu * 6.0) as u64).unwrap();
    let mass_after: f64 = solver.rho().iter().sum();
    assert!((mass_after - mass_before).abs() < 1e-9 * mass_before, "mass drift {}", mass_after - mass_before);
    let height = n as f64;
    for k in 1..=n {
        let z = k as f64 + 0.5;
        let exact = u_w * (height + 1.0 - z) / height;
        let computed = solver.vel()[grid.index(1, 1, k)][0];
        assert!((computed - exact).abs() < 1e-9, "k {k}: {computed} vs {exact}");
        assert!(solver.vel()[grid.index(1, 1, k)][2].abs() < 1e-12, "no wall-normal velocity");
    }
}
