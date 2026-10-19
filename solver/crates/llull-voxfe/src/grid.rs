//! Regular voxel grid: element and node numbering, x fastest.
//!
//! Elements `(i, j, k)`, `0 ≤ i < nx`, … get index `e = i + nx·(j + ny·k)`; nodes `(i, j, k)`, `0 ≤ i ≤ nx`, … get
//! `n = i + (nx+1)·(j + (ny+1)·k)`; DOF `n·dim + c` (c = 0 x, 1 y, 2 z). A 2D grid has `nz = 1` element layer and one node
//! layer (k = 0). y points up: node (0, ny) is the top-left corner.

/// Local node order of an element, as offsets from its origin node: counter-clockwise in the bottom face (z = 0), then the
/// top face (3D). The 2D Q4 uses the first four (top88's order: bottom-left, bottom-right, top-right, top-left).
pub const LOCAL_NODES: [[usize; 3]; 8] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];

/// A regular grid of `nx × ny (× nz)` unit voxels in `dim` = 2 or 3 dimensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Grid {
    pub dim: usize,
    pub nx: usize,
    pub ny: usize,
    /// Element layers in z (1 in 2D).
    pub nz: usize,
}

impl Grid {
    /// A 2D grid of `nx × ny` elements (panics on a zero size).
    pub fn new_2d(nx: usize, ny: usize) -> Grid {
        assert!(nx > 0 && ny > 0, "empty grid");
        Grid { dim: 2, nx, ny, nz: 1 }
    }

    /// A 3D grid of `nx × ny × nz` elements (panics on a zero size).
    pub fn new_3d(nx: usize, ny: usize, nz: usize) -> Grid {
        assert!(nx > 0 && ny > 0 && nz > 0, "empty grid");
        Grid { dim: 3, nx, ny, nz }
    }

    pub fn elements(&self) -> usize {
        self.nx * self.ny * self.nz
    }

    /// Node counts per axis (`nz + 1` in 3D, 1 in 2D).
    pub fn node_dims(&self) -> [usize; 3] {
        [self.nx + 1, self.ny + 1, if self.dim == 3 { self.nz + 1 } else { 1 }]
    }

    pub fn nodes(&self) -> usize {
        let [a, b, c] = self.node_dims();
        a * b * c
    }

    pub fn dofs(&self) -> usize {
        self.nodes() * self.dim
    }

    pub fn nodes_per_element(&self) -> usize {
        1 << self.dim
    }

    pub fn element_dofs(&self) -> usize {
        self.nodes_per_element() * self.dim
    }

    pub fn element(&self, i: usize, j: usize, k: usize) -> usize {
        i + self.nx * (j + self.ny * k)
    }

    pub fn node(&self, i: usize, j: usize, k: usize) -> usize {
        let [a, b, _] = self.node_dims();
        i + a * (j + b * k)
    }

    /// `(i, j, k)` of element `e`.
    pub fn element_ijk(&self, e: usize) -> [usize; 3] {
        [e % self.nx, (e / self.nx) % self.ny, e / (self.nx * self.ny)]
    }

    /// `(i, j, k)` of node `n`.
    pub fn node_ijk(&self, n: usize) -> [usize; 3] {
        let [a, b, _] = self.node_dims();
        [n % a, (n / a) % b, n / (a * b)]
    }

    /// Node index offsets of the local nodes from an element's origin node.
    pub fn local_offsets(&self) -> [usize; 8] {
        let [a, b, _] = self.node_dims();
        LOCAL_NODES.map(|[x, y, z]| x + a * (y + b * z))
    }

    /// Global node indices of element `e` in local order (first `nodes_per_element` entries are meaningful).
    pub fn element_nodes(&self, e: usize) -> [usize; 8] {
        let [i, j, k] = self.element_ijk(e);
        let origin = self.node(i, j, k);
        self.local_offsets().map(|offset| origin + offset)
    }

    /// The grid one multigrid level coarser: each axis halved, rounded up (elements past the fine edge count as void).
    pub fn coarsened(&self) -> Grid {
        Grid { dim: self.dim, nx: self.nx.div_ceil(2), ny: self.ny.div_ceil(2), nz: if self.dim == 3 { self.nz.div_ceil(2) } else { 1 } }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbering_is_x_fastest_and_round_trips() {
        let g = Grid::new_3d(3, 2, 2);
        assert_eq!((g.elements(), g.nodes(), g.dofs()), (12, 36, 108));
        assert_eq!(g.element(1, 1, 1), 1 + 3 * (1 + 2));
        for e in 0..g.elements() {
            let [i, j, k] = g.element_ijk(e);
            assert_eq!(g.element(i, j, k), e);
        }
        for n in 0..g.nodes() {
            let [i, j, k] = g.node_ijk(n);
            assert_eq!(g.node(i, j, k), n);
        }
        assert_eq!(g.element_nodes(0)[6], g.node(1, 1, 1));
        let flat = Grid::new_2d(4, 3);
        assert_eq!((flat.nodes(), flat.dofs(), flat.element_dofs()), (20, 40, 8));
        assert_eq!(flat.element_nodes(0)[..4], [0, 1, 6, 5]);
        assert_eq!(Grid::new_3d(5, 4, 1).coarsened(), Grid::new_3d(3, 2, 1));
    }
}
