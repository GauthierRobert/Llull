//! The uniform flow grid: `nx × ny × nz` cubic cells of side `h` metres, cell `(i, j, k)` at index `i + nx (j + ny k)`,
//! centre `origin + (i + ½, j + ½, k + ½) h`. x is fastest (a ray along +x walks one contiguous run).

/// A uniform cubic-cell grid in the case frame (metres).
#[derive(Debug, Clone, PartialEq)]
pub struct Grid {
    pub nx: usize,
    pub ny: usize,
    pub nz: usize,
    /// Cell side, m.
    pub h: f64,
    /// Minimum corner of cell (0, 0, 0), m.
    pub origin: [f64; 3],
}

impl Grid {
    /// The grid covering `[min, max]` with cells of side `h` (at least one cell per axis; the box is enlarged to whole cells).
    pub fn covering(min: [f64; 3], max: [f64; 3], h: f64) -> Grid {
        let count = |axis: usize| (((max[axis] - min[axis]) / h).ceil().max(1.0)) as usize;
        Grid { nx: count(0), ny: count(1), nz: count(2), h, origin: min }
    }

    pub fn cells(&self) -> usize {
        self.nx * self.ny * self.nz
    }

    pub fn index(&self, i: usize, j: usize, k: usize) -> usize {
        i + self.nx * (j + self.ny * k)
    }

    /// `(i, j, k)` of a linear cell index.
    pub fn coords(&self, cell: usize) -> (usize, usize, usize) {
        (cell % self.nx, (cell / self.nx) % self.ny, cell / (self.nx * self.ny))
    }

    /// Centre of cell `(i, j, k)`, m.
    pub fn centre(&self, i: usize, j: usize, k: usize) -> [f64; 3] {
        [self.origin[0] + (i as f64 + 0.5) * self.h, self.origin[1] + (j as f64 + 0.5) * self.h, self.origin[2] + (k as f64 + 0.5) * self.h]
    }

    /// Maximum corner of the grid, m.
    pub fn max(&self) -> [f64; 3] {
        [self.origin[0] + self.nx as f64 * self.h, self.origin[1] + self.ny as f64 * self.h, self.origin[2] + self.nz as f64 * self.h]
    }

    /// The cell whose box contains `point`, or None outside the grid.
    pub fn cell_at(&self, point: [f64; 3]) -> Option<(usize, usize, usize)> {
        let at = |axis: usize, n: usize| {
            let t = (point[axis] - self.origin[axis]) / self.h;
            (t >= 0.0 && t < n as f64).then_some(t as usize)
        };
        Some((at(0, self.nx)?, at(1, self.ny)?, at(2, self.nz)?))
    }

    /// Neighbour of `(i, j, k)` by the integer offset `c`, with `periodic` axes wrapped; None outside the grid.
    pub fn neighbour(&self, i: usize, j: usize, k: usize, c: [i32; 3], periodic: [bool; 3]) -> Option<(usize, usize, usize)> {
        let step = |value: usize, n: usize, delta: i32, wrap: bool| {
            let next = value as i64 + i64::from(delta);
            if next < 0 || next >= n as i64 {
                wrap.then(|| next.rem_euclid(n as i64) as usize)
            } else {
                Some(next as usize)
            }
        };
        Some((step(i, self.nx, c[0], periodic[0])?, step(j, self.ny, c[1], periodic[1])?, step(k, self.nz, c[2], periodic[2])?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covering_rounds_up_to_whole_cells_and_indexes_x_fastest() {
        let grid = Grid::covering([0.0, 0.0, 0.0], [1.0, 0.5, 0.26], 0.25);
        assert_eq!((grid.nx, grid.ny, grid.nz), (4, 2, 2));
        assert_eq!(grid.cells(), 16);
        assert_eq!(grid.index(1, 1, 1), 1 + 4 * (1 + 2));
        assert_eq!(grid.coords(13), (1, 1, 1));
        assert_eq!(grid.centre(0, 0, 0), [0.125, 0.125, 0.125]);
        assert_eq!(grid.max(), [1.0, 0.5, 0.5]);
        assert_eq!(grid.cell_at([0.3, 0.3, 0.3]), Some((1, 1, 1)));
        assert_eq!(grid.cell_at([1.0, 0.3, 0.3]), None);
    }

    #[test]
    fn neighbours_wrap_only_on_periodic_axes() {
        let grid = Grid::covering([0.0; 3], [1.0; 3], 0.25);
        assert_eq!(grid.neighbour(0, 0, 0, [-1, 0, 0], [false; 3]), None);
        assert_eq!(grid.neighbour(0, 0, 0, [-1, 0, 0], [true, false, false]), Some((3, 0, 0)));
        assert_eq!(grid.neighbour(3, 3, 3, [1, 1, 1], [true; 3]), Some((0, 0, 0)));
        assert_eq!(grid.neighbour(1, 1, 1, [1, -1, 0], [false; 3]), Some((2, 0, 1)));
    }
}
