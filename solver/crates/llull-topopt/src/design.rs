//! The design-variable space of a run (FR-TOP-13 V1 extrusion): which voxels one optimiser variable drives.
//!
//! Without a manufacturing constraint every voxel is its own variable (pinned voxels stay pinned through [`Design`], so the
//! optimiser sees exactly the vectors it saw before). With an **extrusion direction** every column of voxels along that grid
//! axis shares one variable: the design is uniform along the axis by construction (a variable reduction, so the sensitivity of
//! a column variable is the sum over its voxels, not a post-process), and columns without a free voxel are dropped.

use crate::oc::Design;
use llull_voxfe::Grid;

/// Maps optimiser variables to voxels and back.
#[derive(Debug, Clone, PartialEq)]
pub struct DesignSpace {
    /// Per variable, the voxels it drives (free voxels only, in voxel order), or `[voxel]` for the identity.
    members: Vec<Vec<usize>>,
    /// Per variable, whether the optimiser may change it.
    design: Vec<Design>,
    voxels: usize,
    /// The identity mapping: every per-voxel operation is a plain copy (bit-identical to a run without a design space).
    identity: bool,
}

impl DesignSpace {
    /// One variable per voxel, pinned voxels included (the identity mapping).
    pub fn identity(design: &[Design]) -> DesignSpace {
        DesignSpace { members: (0..design.len()).map(|e| vec![e]).collect(), design: design.to_vec(), voxels: design.len(), identity: true }
    }

    /// One variable per column of free voxels along grid axis `axis` (0 = i, 1 = j, 2 = k); columns in the order of their first
    /// voxel.
    pub fn extruded(grid: Grid, design: &[Design], axis: usize) -> DesignSpace {
        let mut columns: Vec<Vec<usize>> = Vec::new();
        let mut column_of: Vec<Option<usize>> = vec![None; grid.elements()];
        for (e, pin) in design.iter().enumerate() {
            if *pin != Design::Free {
                continue;
            }
            let mut ijk = grid.element_ijk(e);
            ijk[axis] = 0;
            let key = grid.element(ijk[0], ijk[1], ijk[2]);
            let column = match column_of[key] {
                Some(column) => column,
                None => {
                    columns.push(Vec::new());
                    column_of[key] = Some(columns.len() - 1);
                    columns.len() - 1
                }
            };
            columns[column].push(e);
        }
        let design = vec![Design::Free; columns.len()];
        DesignSpace { members: columns, design, voxels: grid.elements(), identity: false }
    }

    pub fn variables(&self) -> usize {
        self.members.len()
    }

    /// Per-variable pin state.
    pub fn design(&self) -> &[Design] {
        &self.design
    }

    /// Indices of the variables the optimiser may change.
    pub fn free_variables(&self) -> Vec<usize> {
        (0..self.members.len()).filter(|&v| self.design[v] == Design::Free).collect()
    }

    /// The full per-voxel design from the variables; voxels no variable drives (pinned columns) get `fill`.
    pub fn expand(&self, variables: &[f64], fill: &[f64]) -> Vec<f64> {
        if self.identity {
            return variables.to_vec();
        }
        let mut x = fill.to_vec();
        for (variable, members) in variables.iter().zip(&self.members) {
            for &e in members {
                x[e] = *variable;
            }
        }
        debug_assert_eq!(x.len(), self.voxels);
        x
    }

    /// Per variable, the sum over its voxels (the chain rule of the reduction: a gradient).
    pub fn reduce_sum(&self, per_voxel: &[f64]) -> Vec<f64> {
        if self.identity {
            return per_voxel.to_vec();
        }
        self.members.iter().map(|members| members.iter().fold(0.0, |acc, &e| acc + per_voxel[e])).collect()
    }

    /// Per variable, the mean over its voxels (a design that was not uniform along the axis, e.g. a resumed one).
    pub fn reduce_mean(&self, per_voxel: &[f64]) -> Vec<f64> {
        if self.identity {
            return per_voxel.to_vec();
        }
        self.members.iter().map(|members| members.iter().fold(0.0, |acc, &e| acc + per_voxel[e]) / members.len() as f64).collect()
    }

    /// `per_voxel` with every variable's voxels replaced by their mean (the identity for the identity space): the orthogonal
    /// projector onto fields uniform along the extrusion axis, its own adjoint. Voxels no variable drives are left as they are.
    pub fn uniform(&self, per_voxel: &[f64]) -> Vec<f64> {
        if self.identity {
            return per_voxel.to_vec();
        }
        let mut out = per_voxel.to_vec();
        for (members, mean) in self.members.iter().zip(self.reduce_mean(per_voxel)) {
            for &e in members {
                out[e] = mean;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_keeps_every_voxel_and_its_pin() {
        let design = [Design::Free, Design::Pinned(1.0), Design::Free];
        let space = DesignSpace::identity(&design);
        assert_eq!(space.variables(), 3);
        assert_eq!(space.design(), &design);
        assert_eq!(space.free_variables(), vec![0, 2]);
        assert_eq!(space.expand(&[0.1, 1.0, 0.3], &[9.0; 3]), vec![0.1, 1.0, 0.3]);
        assert_eq!(space.reduce_sum(&[1.0, 2.0, 3.0]), vec![1.0, 2.0, 3.0]);
    }

    #[test]
    fn extrusion_groups_the_free_voxels_of_each_column() {
        // 3 x 2 x 2 grid, extrude along k: column (i, j) = voxels (i, j, 0) and (i, j, 1); voxel (1, 0, *) pinned
        let grid = Grid::new_3d(3, 2, 2);
        let mut design = vec![Design::Free; 12];
        design[grid.element(1, 0, 0)] = Design::Pinned(0.0);
        design[grid.element(1, 0, 1)] = Design::Pinned(0.0);
        let space = DesignSpace::extruded(grid, &design, 2);
        assert_eq!(space.variables(), 5);
        assert!(space.design().iter().all(|d| *d == Design::Free));
        let x = space.expand(&[0.1, 0.2, 0.3, 0.4, 0.5], &[0.0; 12]);
        assert_eq!(x[grid.element(0, 0, 0)], 0.1);
        assert_eq!(x[grid.element(0, 0, 1)], 0.1);
        assert_eq!(x[grid.element(2, 0, 0)], 0.2);
        assert_eq!(x[grid.element(1, 0, 0)], 0.0);
        assert_eq!(x[grid.element(1, 1, 1)], 0.4);
        let gradient: Vec<f64> = (0..12).map(|e| e as f64).collect();
        let reduced = space.reduce_sum(&gradient);
        assert_eq!(reduced[0], (grid.element(0, 0, 0) + grid.element(0, 0, 1)) as f64);
        let mean = space.reduce_mean(&gradient);
        assert_eq!(mean[0], (grid.element(0, 0, 0) + grid.element(0, 0, 1)) as f64 / 2.0);
        let uniform = space.uniform(&gradient);
        assert_eq!(uniform[grid.element(0, 0, 0)], mean[0]);
        assert_eq!(uniform[grid.element(0, 0, 1)], mean[0]);
        assert_eq!(uniform[grid.element(1, 0, 1)], gradient[grid.element(1, 0, 1)]);
        // the projector is idempotent and self-adjoint
        assert_eq!(space.uniform(&uniform), uniform);
        let other: Vec<f64> = (0..12).map(|e| ((e * 5) % 7) as f64).collect();
        let left: f64 = uniform.iter().zip(&other).map(|(a, b)| a * b).sum();
        let right: f64 = gradient.iter().zip(space.uniform(&other)).map(|(a, b)| a * b).sum();
        assert!((left - right).abs() < 1e-12);
        assert_eq!(DesignSpace::identity(&design).uniform(&gradient), gradient);
        // a column with one free voxel (the other pinned) keeps only the free one
        let mut mixed = vec![Design::Free; 12];
        mixed[grid.element(0, 0, 1)] = Design::Pinned(1.0);
        let partial = DesignSpace::extruded(grid, &mixed, 2);
        assert_eq!(partial.variables(), 6);
        let expanded = partial.expand(&[0.7; 6], &[1.0; 12]);
        assert_eq!(expanded[grid.element(0, 0, 0)], 0.7);
        assert_eq!(expanded[grid.element(0, 0, 1)], 1.0);
    }
}
