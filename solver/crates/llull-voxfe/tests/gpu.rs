//! GPU kernels vs the f64 CPU twin (RS1 §2 rule 6): mat-vec, axpy / xpay / product and the fixed-order dot to ~1e-6 relative
//! in f32, the f32 Jacobi PCG and its f64 refinement. Runs where a wgpu adapter exists (lavapipe counts) and otherwise
//! skips with the logged reason.
#![cfg(feature = "gpu")]

use llull_gpu::device::acquire;
use llull_gpu::reduce::dot;
use llull_voxfe::gpu::{refine, GpuOperator, VectorOp};
use llull_voxfe::ke::element_matrix;
use llull_voxfe::multigrid::{Multigrid, MultigridSettings};
use llull_voxfe::pcg::inverse_diagonal;
use llull_voxfe::{solve, Grid, Operator, SolverKind};

fn gpu_or_skip() -> Option<llull_gpu::device::Gpu> {
    match acquire("llull-voxfe test") {
        Ok(gpu) => {
            eprintln!("adapter: {}", gpu.adapter);
            Some(gpu)
        }
        Err(reason) => {
            eprintln!("skipped: GPU unavailable ({reason})");
            None
        }
    }
}

fn relative(a: &[f64], b: &[f64]) -> f64 {
    let diff: f64 = a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum::<f64>().sqrt();
    diff / dot(b, b).sqrt().max(1e-300)
}

/// A grid with a hole of inactive voxels, varied scales and clamped DOFs.
fn operator(grid: Grid) -> Operator {
    let scale: Vec<f64> = (0..grid.elements())
        .map(|e| {
            let [i, j, _] = grid.element_ijk(e);
            if i == grid.nx / 2 && j == grid.ny / 2 {
                0.0
            } else {
                1e-3 + ((e * 7) % 10) as f64 / 10.0
            }
        })
        .collect();
    let fixed: Vec<bool> = (0..grid.dofs()).map(|d| grid.node_ijk(d / grid.dim)[0] == 0).collect();
    Operator::new(grid, element_matrix(grid.dim, 0.3), scale, fixed)
}

#[test]
fn gpu_kernels_match_the_cpu_twin() {
    let Some(gpu) = gpu_or_skip() else { return };
    let mut gpu = Some(gpu);
    for grid in [Grid::new_2d(37, 21), Grid::new_3d(13, 9, 7)] {
        let op = operator(grid);
        let device = GpuOperator::new(gpu.take().unwrap_or_else(|| acquire("llull-voxfe test").unwrap()), &op);
        let n = grid.dofs();
        let u: Vec<f64> = (0..n).map(|d| ((d * 7919) % 1013) as f64 / 1013.0 - 0.5).collect();
        let v: Vec<f64> = (0..n).map(|d| ((d * 104_729) % 997) as f64 / 997.0 + 0.25).collect();
        let mut cpu = vec![0.0; n];
        op.apply(&u, &mut cpu);
        let on_gpu = device.matvec(&u).unwrap();
        let error = relative(&on_gpu, &cpu);
        eprintln!("{}D mat-vec: relative difference {error:.2e}", grid.dim);
        assert!(error < 2e-6, "mat-vec differs by {error:e}");
        assert!(
            relative(
                &device.vector_op(VectorOp::Axpy, 0.75, &u, &u, &v).unwrap(),
                &v.iter().zip(&u).map(|(y, a)| y + 0.75 * a).collect::<Vec<_>>()
            ) < 1e-6
        );
        assert!(
            relative(
                &device.vector_op(VectorOp::Xpay, -0.5, &u, &u, &v).unwrap(),
                &u.iter().zip(&v).map(|(a, y)| a - 0.5 * y).collect::<Vec<_>>()
            ) < 1e-6
        );
        assert!(
            relative(&device.vector_op(VectorOp::Mul, 0.0, &u, &v, &v).unwrap(), &u.iter().zip(&v).map(|(a, b)| a * b).collect::<Vec<_>>())
                < 1e-6
        );
        let (gpu_dot, cpu_dot) = (device.dot(&u, &v).unwrap(), dot(&u, &v));
        let scale: f64 = u.iter().zip(&v).map(|(a, b)| (a * b).abs()).sum();
        assert!((gpu_dot - cpu_dot).abs() / scale < 1e-6, "dot {gpu_dot} vs {cpu_dot}");
        assert_eq!(gpu_dot.to_bits(), device.dot(&u, &v).unwrap().to_bits(), "GPU dot not reproducible");
    }
}

#[test]
fn gpu_pcg_and_f64_refinement_match_the_cpu_solve() {
    let Some(gpu) = gpu_or_skip() else { return };
    let grid = Grid::new_3d(12, 6, 6);
    let op = operator(grid);
    let mut b = vec![0.0; grid.dofs()];
    for k in 0..=grid.nz {
        b[grid.node(grid.nx, 0, k) * 3 + 1] = -1.0;
    }
    let mut reference = vec![0.0; b.len()];
    solve(&op, SolverKind::Jacobi, &b, &mut reference, 1e-10, 10_000).unwrap();
    let device = GpuOperator::new(gpu, &op);
    let f32_solve = device.pcg_f32(&inverse_diagonal(&op), &b, 1e-5, 5_000).unwrap();
    let error = relative(&f32_solve.x, &reference);
    eprintln!("f32 GPU PCG: {} iterations, residual {:.2e}, error {error:.2e}", f32_solve.iterations, f32_solve.relative_residual);
    assert!(error < 1e-3, "f32 solve error {error:e}");
    let mut refined = vec![0.0; b.len()];
    let stats = refine(&device, &op, &b, &mut refined, 1e-10, 1e-4, 5_000).unwrap();
    let error = relative(&refined, &reference);
    eprintln!("refined: {stats:?}, error {error:.2e}");
    assert!(stats.relative_residual <= 1e-10 && error < 1e-7, "refined error {error:e}");
}

#[test]
fn gpu_multigrid_v_cycle_preconditions_the_f32_pcg() {
    let Some(gpu) = gpu_or_skip() else { return };
    let mut gpu = Some(gpu);
    for grid in [Grid::new_2d(40, 24), Grid::new_3d(16, 8, 8)] {
        let op = operator(grid);
        let mut b = vec![0.0; grid.dofs()];
        for k in 0..grid.node_dims()[2] {
            b[grid.node(grid.nx, 0, k) * grid.dim + 1] = -1.0;
        }
        let mut reference = vec![0.0; b.len()];
        solve(&op, SolverKind::Multigrid, &b, &mut reference, 1e-10, 10_000).unwrap();
        let mut device = GpuOperator::new(gpu.take().unwrap_or_else(|| acquire("llull-voxfe test").unwrap()), &op);
        let jacobi = device.pcg_f32(&inverse_diagonal(&op), &b, 1e-4, 20_000).unwrap();
        let hierarchy = Multigrid::<f32>::new(&op, MultigridSettings::default());
        device.set_multigrid(&hierarchy);
        let multigrid = device.pcg_f32(&inverse_diagonal(&op), &b, 1e-4, 20_000).unwrap();
        eprintln!("{}D f32 GPU PCG to 1e-4: Jacobi {} iterations, V-cycle {}", grid.dim, jacobi.iterations, multigrid.iterations);
        assert!(multigrid.relative_residual <= 1e-4 && multigrid.iterations * 4 < jacobi.iterations);
        let mut refined = vec![0.0; b.len()];
        let stats = refine(&device, &op, &b, &mut refined, 1e-10, 1e-4, 5_000).unwrap();
        let error = relative(&refined, &reference);
        eprintln!("V-cycle refinement: {stats:?}, error {error:.2e}");
        assert!(stats.relative_residual <= 1e-10 && error < 1e-7, "refined error {error:e}");
        // new scales: the hierarchy is updated and uploaded in place and still preconditions
        let doubled: Vec<f64> = op.scale().iter().map(|s| s * 2.0).collect();
        let rescaled = Operator::new(grid, op.ke().to_vec(), doubled, op.fixed().to_vec());
        let mut updated = hierarchy;
        updated.update(&rescaled);
        device.set_scale(rescaled.scale());
        device.set_multigrid(&updated);
        let mut halved = vec![0.0; b.len()];
        refine(&device, &rescaled, &b, &mut halved, 1e-10, 1e-4, 5_000).unwrap();
        let doubled_back: Vec<f64> = halved.iter().map(|u| 2.0 * u).collect();
        assert!(relative(&doubled_back, &reference) < 1e-7);
    }
}
