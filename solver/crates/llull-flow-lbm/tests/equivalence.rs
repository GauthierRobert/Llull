//! VC-CFD-26: the GPU kernels and the CPU twin agree on a sphere case — fields within 1e-4 of their range, the total force
//! within 1e-5 of its magnitude. Skipped with a logged reason when no adapter can be opened (`LLULL_GPU=off`, no driver).

#![cfg(feature = "gpu")]

use llull_flow_core::grid::Grid;
use llull_flow_core::stl::sphere_triangles;
use llull_flow_core::voxel::voxelise;
use llull_flow_lbm::cpu::CpuSolver;
use llull_flow_lbm::domain::{Domain, INLET, OUTLET, SLIP_X};
use llull_flow_lbm::gpu::GpuSolver;
use llull_flow_lbm::kernel::Params;
use llull_flow_lbm::solver::Backend;

fn sphere_domain() -> Domain {
    let grid = Grid::covering([0.0; 3], [30.0, 18.0, 18.0], 1.0);
    let triangles = sphere_triangles([10.0, 9.0, 9.0], 3.0, 16, 32);
    let voxels = voxelise(&grid, &triangles, &vec![0; triangles.len()]);
    let mut domain = Domain::new(grid, [false; 3]);
    domain.set_face(0, false, INLET);
    domain.set_face(0, true, OUTLET);
    for axis in 1..3 {
        domain.set_face(axis, false, SLIP_X + axis as u8);
        domain.set_face(axis, true, SLIP_X + axis as u8);
    }
    domain.set_solids(&voxels, 1);
    domain
}

fn range(values: impl Iterator<Item = f32>) -> f32 {
    let (min, max) = values.fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), v| (lo.min(v), hi.max(v)));
    (max - min).max(1e-30)
}

#[test]
fn gpu_and_cpu_agree_on_fields_and_forces() {
    let domain = sphere_domain();
    let params = Params { tau: 0.6, smagorinsky: 0.1, u_in: [0.05, 0.0, 0.0], u_wall: [0.0; 3], body_force: [0.0; 3] };
    let initial = |_: usize| (1.0f32, [0.05f32, 0.0, 0.0]);
    let mut gpu = match GpuSolver::new(&domain, params, initial) {
        Ok(gpu) => gpu,
        Err(reason) => {
            eprintln!("VC-CFD-26 skipped: {reason}");
            return;
        }
    };
    let mut cpu = CpuSolver::new(domain.clone(), params, initial);
    for backend in [&mut cpu as &mut dyn Backend, &mut gpu as &mut dyn Backend] {
        backend.advance(200).unwrap();
        backend.accumulate().unwrap();
        backend.advance(50).unwrap();
        backend.accumulate().unwrap();
    }
    let (cpu_rho, cpu_vel, _) = Backend::averages(&mut cpu).unwrap();
    let (gpu_rho, gpu_vel, _) = gpu.averages().unwrap();
    let rho_range = range(cpu_rho.iter().copied());
    let rho_error = cpu_rho.iter().zip(&gpu_rho).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max) / rho_range;
    let speed = |u: &[f32; 3]| (u[0] * u[0] + u[1] * u[1] + u[2] * u[2]).sqrt();
    let speed_range = range(cpu_vel.iter().map(speed));
    let vel_error = cpu_vel
        .iter()
        .zip(&gpu_vel)
        .map(|(a, b)| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt())
        .fold(0.0f32, f32::max)
        / speed_range;
    let total = |force: Vec<[f32; 3]>| {
        force.iter().fold([0.0f64; 3], |acc, f| [acc[0] + f64::from(f[0]), acc[1] + f64::from(f[1]), acc[2] + f64::from(f[2])])
    };
    let cpu_force = total(Backend::force(&mut cpu).unwrap());
    let gpu_force = total(gpu.force().unwrap());
    let magnitude = (cpu_force[0].powi(2) + cpu_force[1].powi(2) + cpu_force[2].powi(2)).sqrt();
    let force_error =
        ((cpu_force[0] - gpu_force[0]).powi(2) + (cpu_force[1] - gpu_force[1]).powi(2) + (cpu_force[2] - gpu_force[2]).powi(2)).sqrt()
            / magnitude;
    eprintln!(
        "VC-CFD-26 on {}: rho {rho_error:.2e}, velocity {vel_error:.2e}, force {force_error:.2e} (|F| {magnitude:.4e})",
        gpu.adapter()
    );
    assert!(rho_error < 1e-4, "density fields differ by {rho_error}");
    assert!(vel_error < 1e-4, "velocity fields differ by {vel_error}");
    assert!(force_error < 1e-5, "forces differ by {force_error}");
    assert_eq!(gpu.info().device, "gpu");
    assert!(!gpu.info().deterministic);
}
