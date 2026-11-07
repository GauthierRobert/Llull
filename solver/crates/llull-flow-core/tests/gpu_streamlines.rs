//! VC-CFD-42: the wgpu streamline kernel and the f64 CPU integrator agree on an analytic field (a helix: solid-body rotation
//! plus axial flow, with a solid block and a symmetry plane), point for point within 1e-4 of the domain size, with the same
//! stop reasons. Skipped with a logged reason when no adapter can be opened (`LLULL_GPU=off`, no driver).

#![cfg(feature = "gpu")]

use llull_flow_core::field::FlowField;
use llull_flow_core::gpu_streamline::trace_gpu;
use llull_flow_core::grid::Grid;
use llull_flow_core::streamline::{trace_cpu, Settings};

fn helix() -> FlowField {
    let grid = Grid::covering([0.0, 0.0, 0.0], [2.0, 2.0, 4.0], 0.05);
    let n = grid.cells();
    let centre = |cell: usize| {
        let (i, j, k) = grid.coords(cell);
        grid.centre(i, j, k)
    };
    let blocked = |c: [f64; 3]| (0.4..0.6).contains(&c[0]) && (0.9..1.1).contains(&c[1]) && (2.5..2.7).contains(&c[2]);
    FlowField {
        ux: (0..n).map(|c| -(centre(c)[1] - 1.0) as f32).collect(),
        uy: (0..n).map(|c| (centre(c)[0] - 1.0) as f32).collect(),
        uz: vec![0.3; n],
        p: vec![0.0; n],
        valid: (0..n).map(|c| !blocked(centre(c))).collect(),
        grid,
        mirrors: vec![],
    }
}

#[test]
fn gpu_and_cpu_streamlines_agree() {
    let field = helix();
    let seeds: Vec<[f64; 3]> = (0..24).map(|s| [1.0 + 0.03 * f64::from(s), 1.0, 1.0 + 0.05 * f64::from(s % 5)]).collect();
    let settings = Settings { step_m: 0.02, max_length_m: 30.0, max_steps: 1500, min_speed_ms: 1e-4, forward: true, backward: true };
    let (gpu, adapter) = match trace_gpu(&field, &seeds, &settings) {
        Ok(found) => found,
        Err(reason) => {
            eprintln!("VC-CFD-42 skipped: {reason}");
            return;
        }
    };
    let cpu = trace_cpu(&field, &seeds, &settings);
    let mut worst: f64 = 0.0;
    let mut compared = 0;
    for (a, b) in cpu.iter().zip(&gpu) {
        assert_eq!(a.seed_speed.is_ok(), b.seed_speed.is_ok());
        for (ha, hb) in [(&a.forward, &b.forward), (&a.backward, &b.backward)] {
            assert_eq!(ha.stop, hb.stop, "stop reasons");
            let shared = ha.points.len().min(hb.points.len());
            assert!(ha.points.len().abs_diff(hb.points.len()) <= 1, "{} vs {} points", ha.points.len(), hb.points.len());
            for k in 0..shared {
                for axis in 0..3 {
                    worst = worst.max((ha.points[k][axis] - hb.points[k][axis]).abs());
                }
                compared += 1;
            }
        }
    }
    eprintln!("VC-CFD-42 on {adapter}: {compared} points, worst difference {worst:.3e} m (domain 4 m)");
    assert!(compared > 5_000, "{compared} points compared");
    assert!(worst < 4e-4, "worst point difference {worst}");
}
