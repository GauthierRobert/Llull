//! Displacement constraints (TECHNICAL_SPEC §15.8): `|ū| ≤ limit` where `ū = ℓᵀ u_lc` is the mean displacement component of a
//! node set in one load case. Written for MMA as `ū² / limit² − 1 ≤ 0` (sign agnostic, O(1)); its gradient comes from one
//! adjoint solve `K λ = ℓ` per constraint and iteration (cold start: the adjoint carries no resume state):
//! `dū/dx_e = λᵀ (∂F/∂x_e − ∂K_e/∂x_e u) = −p (E0 − Emin) xPhys_e^(p−1) g λ_eᵀ k0 u_e + λ_eᵀ f_e` (the second term for gravity).
//! The cross energy `λ_eᵀ k0 u_e` is the polarisation `¼ (E(u + λ) − E(u − λ))` of the element energies.

use crate::loads::gravity_work;
use crate::simp::{Problem, TopError};
use crate::solver::Solver;
use llull_voxfe::Operator;
use rayon::prelude::*;

/// `|mean of u[dofs]| ≤ limit` in load case `load_case`.
#[derive(Debug, Clone, PartialEq)]
pub struct DisplacementConstraint {
    pub label: String,
    pub load_case: usize,
    /// The DOFs whose mean displacement is limited (one component of one or more nodes).
    pub dofs: Vec<usize>,
    pub limit: f64,
}

impl DisplacementConstraint {
    /// `ū` of a displacement vector.
    pub fn value(&self, u: &[f64]) -> f64 {
        self.dofs.iter().map(|&d| u[d]).sum::<f64>() / self.dofs.len() as f64
    }

    fn rhs(&self, len: usize) -> Vec<f64> {
        let mut b = vec![0.0; len];
        let weight = 1.0 / self.dofs.len() as f64;
        for &d in &self.dofs {
            b[d] += weight;
        }
        b
    }
}

/// Size, index and sign checks of the constraints (the job reader reports them as `NATIVE_JOB_INPUT`).
pub fn validate(constraints: &[DisplacementConstraint], problem: &Problem) -> Result<(), String> {
    for c in constraints {
        let name = &c.label;
        if c.load_case >= problem.load_cases.len() {
            return Err(format!("displacement constraint '{name}': load case {} does not exist", c.load_case));
        }
        if c.dofs.is_empty() || c.dofs.iter().any(|&d| d >= problem.grid.dofs()) {
            return Err(format!("displacement constraint '{name}': needs at least one DOF inside the grid"));
        }
        if c.dofs.iter().any(|&d| problem.fixed[d]) {
            return Err(format!("displacement constraint '{name}': a constrained DOF is fixed (its displacement is 0)"));
        }
        if !(c.limit.is_finite() && c.limit > 0.0) {
            return Err(format!("displacement constraint '{name}': maxDisplacement must be > 0"));
        }
    }
    Ok(())
}

/// Raw `dū/dx_e` per element for the displacement `u` of the constraint's load case (before projection / filter / reduction).
#[allow(clippy::too_many_arguments)]
pub(crate) fn sensitivity(
    op: &Operator,
    solver: &mut Solver<'_>,
    problem: &Problem,
    constraint: &DisplacementConstraint,
    u: &[f64],
    factor: f64,
    x_phys: &[f64],
    active: &[bool],
    penal: f64,
) -> Result<Vec<f64>, TopError> {
    let lambda = solver.solve_cold(op, &constraint.rhs(u.len()))?;
    let plus: Vec<f64> = u.iter().zip(&lambda).map(|(a, b)| a + b).collect();
    let minus: Vec<f64> = u.iter().zip(&lambda).map(|(a, b)| a - b).collect();
    let (e_plus, e_minus) = (op.element_energies(&plus), op.element_energies(&minus));
    let gravity = problem.load_cases[constraint.load_case].gravity.map(|g| gravity_work(&problem.grid, &lambda, active, g));
    Ok((0..problem.grid.elements())
        .into_par_iter()
        .map(|e| {
            let cross = 0.25 * (e_plus[e] - e_minus[e]);
            factor * x_phys[e].powf(penal - 1.0) * cross + gravity.as_ref().map_or(0.0, |w| w[e])
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::loads::with_gravity;
    use crate::simp::{element_scales, Device, LoadCase, Objective, Settings, Voxel};
    use crate::solver::{choose_backend, Solver};
    use llull_voxfe::ke::element_matrix;
    use llull_voxfe::Grid;

    /// ū(x) of a 4 x 3 plate (clamped left edge, tip load and gravity) for the design `x`.
    fn tip_displacement(problem: &Problem, settings: &Settings, x: &[f64], constraint: &DisplacementConstraint) -> f64 {
        let op = Operator::new(
            problem.grid,
            element_matrix(2, problem.nu),
            element_scales(x, &problem.voxels, problem, settings, problem.thickness),
            problem.fixed.clone(),
        );
        let (backend, _) = choose_backend(Device::Cpu, &op);
        let mut solver =
            Solver { settings, backend, multigrid: None, stale: true, warm: vec![Vec::new()], pcg_iterations: 0, warnings: Vec::new() };
        let case = &problem.load_cases[0];
        let active = vec![true; x.len()];
        let b = with_gravity(&problem.grid, &case.forces, x, &active, case.gravity.unwrap());
        constraint.value(&solver.solve(&op, 0, &b).unwrap())
    }

    #[test]
    fn adjoint_sensitivity_matches_finite_differences_with_gravity() {
        let grid = Grid::new_2d(4, 3);
        let mut fixed = vec![false; grid.dofs()];
        for j in 0..=3 {
            fixed[2 * grid.node(0, j, 0)] = true;
            fixed[2 * grid.node(0, j, 0) + 1] = true;
        }
        let mut forces = vec![0.0; grid.dofs()];
        forces[2 * grid.node(4, 0, 0) + 1] = -1.0;
        let problem = Problem {
            grid,
            voxels: vec![Voxel::Free; grid.elements()],
            fixed,
            load_cases: vec![LoadCase { name: "a".into(), weight: 1.0, forces, gravity: Some([0.0, -0.3, 0.0]) }],
            e0: 1.0,
            nu: 0.3,
            thickness: 1.0,
            voxel: 1.0,
            volume_fraction: 0.5,
            objective: Objective::MinCompliance,
            displacement_constraints: Vec::new(),
        };
        let settings = Settings { solver: llull_voxfe::SolverKind::Jacobi, ..Settings::default() };
        let constraint = DisplacementConstraint { label: "tip".into(), load_case: 0, dofs: vec![2 * grid.node(4, 0, 0) + 1], limit: 1.0 };
        let x: Vec<f64> = (0..grid.elements()).map(|e| 0.35 + 0.05 * e as f64).collect();
        let op = Operator::new(
            grid,
            element_matrix(2, 0.3),
            element_scales(&x, &problem.voxels, &problem, &settings, 1.0),
            problem.fixed.clone(),
        );
        let (backend, _) = choose_backend(Device::Cpu, &op);
        let mut solver = Solver {
            settings: &settings,
            backend,
            multigrid: None,
            stale: true,
            warm: vec![Vec::new()],
            pcg_iterations: 0,
            warnings: Vec::new(),
        };
        let active = vec![true; x.len()];
        let case = &problem.load_cases[0];
        let u = solver.solve(&op, 0, &with_gravity(&grid, &case.forces, &x, &active, case.gravity.unwrap())).unwrap();
        let factor = -settings.penal * (problem.e0 - settings.emin_ratio * problem.e0);
        let analytic = sensitivity(&op, &mut solver, &problem, &constraint, &u, factor, &x, &active, settings.penal).unwrap();
        for e in [0, 5, 11] {
            let h = 1e-6;
            let (mut up, mut down) = (x.clone(), x.clone());
            up[e] += h;
            down[e] -= h;
            let fd = (tip_displacement(&problem, &settings, &up, &constraint) - tip_displacement(&problem, &settings, &down, &constraint))
                / (2.0 * h);
            assert!((fd - analytic[e]).abs() <= 1e-5 * fd.abs().max(1e-3), "element {e}: fd {fd}, adjoint {}", analytic[e]);
        }
    }

    #[test]
    fn value_is_the_mean_of_the_dofs_and_the_rhs_sums_to_one() {
        let c = DisplacementConstraint { label: "t".into(), load_case: 0, dofs: vec![1, 3], limit: 1.0 };
        assert_eq!(c.value(&[0.0, 2.0, 0.0, 4.0]), 3.0);
        let b = c.rhs(4);
        assert_eq!(b, vec![0.0, 0.5, 0.0, 0.5]);
    }
}
