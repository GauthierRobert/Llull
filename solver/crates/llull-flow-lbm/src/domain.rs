//! The solver domain: the grid, one flag per cell and the body each solid cell belongs to. Fluid cells are the only ones that
//! stream and collide; every other flag names what a fluid cell pulls from that neighbour (TECHNICAL_SPEC §5.3 boundaries):
//! half-way bounce-back on `SOLID` / `MOVING_WALL`, equilibrium at the inflow velocity on `INLET`, zero-gradient extrapolation at
//! the reference pressure on `OUTLET`, specular reflection on `SLIP_*` (free-slip side walls and symmetry planes). On a
//! non-periodic axis the outermost cell layer holds the face flags; the body lies strictly inside.

use crate::lattice::{C, Q};
use llull_flow_core::grid::Grid;
use llull_flow_core::voxel::{Voxelisation, NO_BODY};

pub const FLUID: u8 = 0;
pub const SOLID: u8 = 1;
pub const INLET: u8 = 2;
pub const OUTLET: u8 = 3;
/// Free-slip wall normal to x (`SLIP_X + axis` for y and z).
pub const SLIP_X: u8 = 4;
pub const SLIP_Y: u8 = 5;
pub const SLIP_Z: u8 = 6;
/// No-slip wall moving at the wall velocity of the parameters (the ground of a road vehicle case).
pub const MOVING_WALL: u8 = 7;

/// Grid + flags + body ids.
#[derive(Debug, Clone, PartialEq)]
pub struct Domain {
    pub grid: Grid,
    pub flags: Vec<u8>,
    /// Body of a solid cell ([`NO_BODY`] elsewhere, and for a ground / face wall).
    pub body: Vec<u16>,
    pub bodies: usize,
    pub periodic: [bool; 3],
}

impl Domain {
    /// An all-fluid domain.
    pub fn new(grid: Grid, periodic: [bool; 3]) -> Domain {
        let cells = grid.cells();
        Domain { grid, flags: vec![FLUID; cells], body: vec![NO_BODY; cells], bodies: 0, periodic }
    }

    /// Gives the outermost layer of cells on the `high` (max) or low (min) side of `axis` the flag `flag`, where it is still fluid
    /// (so the first face set wins at edges and corners). No-op on a periodic axis.
    pub fn set_face(&mut self, axis: usize, high: bool, flag: u8) {
        if self.periodic[axis] {
            return;
        }
        let n = [self.grid.nx, self.grid.ny, self.grid.nz];
        let layer = if high { n[axis] - 1 } else { 0 };
        for cell in 0..self.grid.cells() {
            let coords = self.grid.coords(cell);
            let at = [coords.0, coords.1, coords.2][axis];
            if at == layer && self.flags[cell] == FLUID {
                self.flags[cell] = flag;
            }
        }
    }

    /// Marks the solid cells of `voxels` (same grid) with their bodies.
    pub fn set_solids(&mut self, voxels: &Voxelisation, bodies: usize) {
        assert_eq!(voxels.solid.len(), self.flags.len(), "voxelisation of another grid");
        for (cell, solid) in voxels.solid.iter().enumerate() {
            if *solid {
                self.flags[cell] = SOLID;
                self.body[cell] = voxels.body[cell];
            }
        }
        self.bodies = self.bodies.max(bodies);
    }

    pub fn is_fluid(&self, cell: usize) -> bool {
        self.flags[cell] == FLUID
    }

    pub fn fluid_cells(&self) -> usize {
        self.flags.iter().filter(|flag| **flag == FLUID).count()
    }

    pub fn solid_cells(&self) -> usize {
        self.flags.iter().filter(|flag| **flag == SOLID).count()
    }

    /// The cell a population with velocity `c_q` arrives from at `(i, j, k)`: `x − c_q`, wrapped on periodic axes; None when it
    /// would leave the grid on a non-periodic axis (a fluid cell never has such a neighbour once the faces are set).
    pub fn source(&self, i: usize, j: usize, k: usize, q: usize) -> Option<usize> {
        let c = C[q];
        self.grid.neighbour(i, j, k, [-c[0], -c[1], -c[2]], self.periodic).map(|(a, b, d)| self.grid.index(a, b, d))
    }

    /// Per cell, the body of the first solid neighbour among the 18 directions (NO_BODY when none): where this cell's wall
    /// links deposit their momentum. A fluid cell touching two bodies attributes every link to the first (documented bias).
    pub fn link_body(&self) -> Vec<u16> {
        (0..self.grid.cells())
            .map(|cell| {
                if !self.is_fluid(cell) {
                    return NO_BODY;
                }
                let (i, j, k) = self.grid.coords(cell);
                (1..Q)
                    .filter_map(|q| self.source(i, j, k, q))
                    .find(|src| (self.flags[*src] == SOLID || self.flags[*src] == MOVING_WALL) && self.body[*src] != NO_BODY)
                    .map_or(NO_BODY, |src| self.body[src])
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use llull_flow_core::stl::box_triangles;
    use llull_flow_core::voxel::voxelise;

    #[test]
    fn faces_fill_the_outer_layers_in_call_order_and_skip_periodic_axes() {
        let grid = Grid::covering([0.0; 3], [4.0, 3.0, 3.0], 1.0);
        let mut domain = Domain::new(grid.clone(), [false, true, false]);
        domain.set_face(0, false, INLET);
        domain.set_face(0, true, OUTLET);
        domain.set_face(2, false, SOLID);
        domain.set_face(2, true, SLIP_Z);
        domain.set_face(1, false, SLIP_Y);
        assert_eq!(domain.flags[grid.index(0, 1, 1)], INLET);
        assert_eq!(domain.flags[grid.index(3, 1, 1)], OUTLET);
        assert_eq!(domain.flags[grid.index(0, 1, 0)], INLET, "the first face set wins at an edge");
        assert_eq!(domain.flags[grid.index(1, 1, 0)], SOLID);
        assert_eq!(domain.flags[grid.index(1, 1, 2)], SLIP_Z);
        assert_eq!(domain.flags[grid.index(1, 0, 1)], FLUID, "periodic y: no face layer");
        assert_eq!(domain.fluid_cells(), 2 * 3);
        assert_eq!(domain.source(0, 0, 1, 3), Some(grid.index(0, 2, 1)), "wraps on the periodic axis");
        assert_eq!(domain.source(0, 0, 1, 1), None);
    }

    #[test]
    fn solids_carry_their_body_and_fluid_neighbours_link_to_it() {
        let grid = Grid::covering([0.0; 3], [6.0; 3], 1.0);
        let triangles = box_triangles([2.0; 3], [4.0; 3]);
        let voxels = voxelise(&grid, &triangles, &[3; 12]);
        let mut domain = Domain::new(grid.clone(), [true; 3]);
        domain.set_solids(&voxels, 4);
        assert_eq!(domain.solid_cells(), 8);
        assert_eq!(domain.bodies, 4);
        let links = domain.link_body();
        assert_eq!(links[grid.index(1, 2, 2)], 3);
        assert_eq!(links[grid.index(1, 1, 2)], 3, "an edge-diagonal link counts");
        assert_eq!(links[grid.index(1, 1, 1)], NO_BODY, "D3Q19 has no corner link");
        assert_eq!(links[grid.index(0, 0, 0)], NO_BODY);
        assert_eq!(links[grid.index(2, 2, 2)], NO_BODY, "solid cells have no links");
    }
}
