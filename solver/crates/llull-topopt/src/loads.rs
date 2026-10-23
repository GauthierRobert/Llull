//! Design-dependent body loads (gravity, FR-TOP-13 / §14 open item): a load case may carry a force per fully solid voxel
//! `g` (ρ · a · V_voxel, consistent units); voxel `e` then applies `xPhys_e · g / nodes_per_element` at each of its nodes, so
//! `F(x) = F_fixed + Σ_e xPhys_e f_e` and the compliance sensitivity gains `2 u_eᵀ f_e` (TECHNICAL_SPEC §15.3). Every sum runs
//! in a fixed node order: bit-identical for any thread count.

use llull_voxfe::Grid;
use llull_voxfe::MIN_LEN;
use rayon::prelude::*;

/// The `active` voxels adjacent to node `n`, in a fixed order (the element offsets of `LOCAL_NODES`, negated).
fn adjacent_elements(grid: &Grid, n: usize, active: &[bool]) -> Vec<usize> {
    let [i, j, k] = grid.node_ijk(n);
    let mut elements = Vec::with_capacity(grid.nodes_per_element());
    let layers = if grid.dim == 3 { 2 } else { 1 };
    for dk in 0..layers {
        for dj in 0..2 {
            for di in 0..2 {
                if i >= di && j >= dj && k >= dk && i - di < grid.nx && j - dj < grid.ny && k - dk < grid.nz {
                    let e = grid.element(i - di, j - dj, k - dk);
                    if active[e] {
                        elements.push(e);
                    }
                }
            }
        }
    }
    elements
}

/// `forces + Σ_e xPhys_e · g / nodes_per_element` gathered at every node (DOF-length).
pub fn with_gravity(grid: &Grid, forces: &[f64], x_phys: &[f64], active: &[bool], g: [f64; 3]) -> Vec<f64> {
    let dim = grid.dim;
    let share = 1.0 / grid.nodes_per_element() as f64;
    let mut out = forces.to_vec();
    out.par_chunks_mut(dim).enumerate().with_min_len(MIN_LEN / dim).for_each(|(n, dofs)| {
        let density: f64 = adjacent_elements(grid, n, active).iter().fold(0.0, |acc, &e| acc + x_phys[e]);
        for (c, dof) in dofs.iter_mut().enumerate() {
            *dof += density * share * g[c];
        }
    });
    out
}

/// Per element, `u_eᵀ f_e` for `xPhys_e = 1`: `(g / nodes_per_element) · Σ_nodes u_node` (0 for inactive elements).
pub fn gravity_work(grid: &Grid, u: &[f64], active: &[bool], g: [f64; 3]) -> Vec<f64> {
    let dim = grid.dim;
    let share = 1.0 / grid.nodes_per_element() as f64;
    (0..grid.elements())
        .into_par_iter()
        .with_min_len(MIN_LEN)
        .map(|e| {
            if !active[e] {
                return 0.0;
            }
            let nodes = grid.element_nodes(e);
            let mut work = 0.0;
            for &node in &nodes[..grid.nodes_per_element()] {
                for c in 0..dim {
                    work += u[node * dim + c] * g[c] * share;
                }
            }
            work
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gravity_is_distributed_equally_and_totals_the_solid_volume() {
        let grid = Grid::new_2d(3, 2);
        let active = vec![true; 6];
        let x_phys = vec![0.5; 6];
        let f = with_gravity(&grid, &vec![0.0; grid.dofs()], &x_phys, &active, [0.0, -2.0, 0.0]);
        let total: f64 = f.iter().skip(1).step_by(2).sum();
        assert!((total - 6.0 * 0.5 * -2.0).abs() < 1e-12, "{total}");
        assert!(f.iter().step_by(2).all(|fx| *fx == 0.0));
        // corner node (0, 0): one element, share 1/4
        assert!((f[1] - 0.5 * -2.0 / 4.0).abs() < 1e-15);
        // an inactive element contributes nothing
        let mut partly = active.clone();
        partly[0] = false;
        let g = with_gravity(&grid, &vec![0.0; grid.dofs()], &x_phys, &partly, [0.0, -2.0, 0.0]);
        assert_eq!(g[1], 0.0);
    }

    #[test]
    fn gravity_work_is_the_dot_product_with_the_unit_element_load() {
        let grid = Grid::new_3d(2, 1, 1);
        let active = vec![true, false];
        let u: Vec<f64> = (0..grid.dofs()).map(|d| d as f64).collect();
        let work = gravity_work(&grid, &u, &active, [0.0, 0.0, 8.0]);
        let expected: f64 = grid.element_nodes(0).iter().map(|&n| u[n * 3 + 2]).sum::<f64>();
        assert!((work[0] - expected).abs() < 1e-12);
        assert_eq!(work[1], 0.0);
        // consistency with with_gravity: Σ_e xPhys_e work_e = u · (F(x) − F_fixed)
        let x_phys = vec![0.3, 0.9];
        let forces = with_gravity(&grid, &vec![0.0; grid.dofs()], &x_phys, &active, [0.0, 0.0, 8.0]);
        let lhs: f64 = x_phys.iter().zip(&work).map(|(x, w)| x * w).sum();
        let rhs: f64 = u.iter().zip(&forces).map(|(a, b)| a * b).sum();
        assert!((lhs - rhs).abs() < 1e-12, "{lhs} vs {rhs}");
    }
}
