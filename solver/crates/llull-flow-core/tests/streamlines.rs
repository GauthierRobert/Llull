//! VC-CFD-40: streamlines of the potential flow about a sphere (radius R, free stream U along x) sampled on the cell grid with the
//! sphere voxelised solid conserve the Stokes stream function psi = U r^2 sin^2(theta) (1 - R^3 / r^3) / 2 along each line, and
//! cross x = 0 at the offset the exact solution predicts (TECHNICAL_SPEC §9: `tests/streamlines.rs`, analytic sphere field).

use llull_flow_core::field::FlowField;
use llull_flow_core::grid::Grid;
use llull_flow_core::streamline::{trace_cpu, Settings, Stop};

const R: f64 = 1.0;

/// Potential flow u = U [1 + R^3 (r^2 - 3 x^2) / (2 r^5), -3 R^3 x y / (2 r^5), -3 R^3 x z / (2 r^5)], U = 1, on cell centres.
fn sphere_field(h: f64) -> FlowField {
    let grid = Grid::covering([-4.0, -2.5, -2.5], [4.0, 2.5, 2.5], h);
    let n = grid.cells();
    let mut field = FlowField {
        ux: vec![0.0; n],
        uy: vec![0.0; n],
        uz: vec![0.0; n],
        p: vec![0.0; n],
        valid: vec![true; n],
        grid: grid.clone(),
        mirrors: vec![],
    };
    for cell in 0..n {
        let (i, j, k) = grid.coords(cell);
        let [x, y, z] = grid.centre(i, j, k);
        let r2 = x * x + y * y + z * z;
        let r = r2.sqrt();
        if r < R {
            field.valid[cell] = false;
            continue;
        }
        let r5 = r2 * r2 * r;
        field.ux[cell] = (1.0 + R.powi(3) * (r2 - 3.0 * x * x) / (2.0 * r5)) as f32;
        field.uy[cell] = (-3.0 * R.powi(3) * x * y / (2.0 * r5)) as f32;
        field.uz[cell] = (-3.0 * R.powi(3) * x * z / (2.0 * r5)) as f32;
    }
    field
}

fn psi(p: [f64; 3]) -> f64 {
    let rho2 = p[1] * p[1] + p[2] * p[2];
    let r = (p[0] * p[0] + rho2).sqrt();
    0.5 * rho2 * (1.0 - R.powi(3) / r.powi(3))
}

#[test]
fn potential_flow_streamlines_conserve_the_stream_function() {
    let h = 0.05;
    let field = sphere_field(h);
    let seeds: Vec<[f64; 3]> = [0.3, 0.5, 0.8, 1.2].iter().map(|y0| [-3.5, *y0, 0.0]).collect();
    let settings = Settings { step_m: h / 2.0, max_length_m: 20.0, max_steps: 20_000, min_speed_ms: 1e-4, forward: true, backward: false };
    let traced = trace_cpu(&field, &seeds, &settings);
    let mut worst: f64 = 0.0;
    for (seed, line) in seeds.iter().zip(&traced) {
        assert_eq!(line.forward.stop, Some(Stop::LeftDomain), "seed {seed:?}");
        let psi0 = psi(*seed);
        // Away from the staircase surface (two cells), where the sampled field is the analytic one up to the trilinear error.
        for point in line.forward.points.iter().filter(|p| (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt() > R + 2.0 * h) {
            worst = worst.max((psi(*point) - psi0).abs() / psi0);
        }
        // The exact streamline crosses x = 0 at the rho where psi(0, rho) = psi0.
        let crossing = line.forward.points.windows(2).find(|w| w[0][0] < 0.0 && w[1][0] >= 0.0).expect("the line passes the sphere");
        let t = -crossing[0][0] / (crossing[1][0] - crossing[0][0]);
        let rho = crossing[0][1] + t * (crossing[1][1] - crossing[0][1]);
        let (mut lo, mut hi) = (R, 4.0);
        for _ in 0..60 {
            let mid = 0.5 * (lo + hi);
            if psi([0.0, mid, 0.0]) < psi0 {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        eprintln!("VC-CFD-40 seed y0 = {}: offset at x = 0 {rho:.5} vs exact {lo:.5} ({:.2e} R)", seed[1], (rho - lo).abs() / R);
        assert!((rho - lo).abs() < 2e-3 * R, "offset {rho} vs {lo}");
    }
    eprintln!("VC-CFD-40: worst relative stream-function drift {worst:.2e}");
    assert!(worst < 2e-3, "stream function drift {worst}");
}
