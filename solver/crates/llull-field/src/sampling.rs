//! Grid sampling with interval pruning: twin of `sampleGrid` in `tsEngine.ts`. Tiles of 8 cells are interval-evaluated first; a node
//! whose every tile is proved empty (full) holds +-1e30 without being sampled, any other node is evaluated. The classification is global and
//! the planes are produced one at a time, so a grid of 10^9 nodes never lives in memory at once.

use crate::eval::Evaluator;
use crate::interval::IntervalScratch;
use rayon::prelude::*;

pub const TILE: usize = 8;
pub const OUTSIDE: f64 = 1e30;
/// Samples closer to the surface than this fraction of a voxel become +ZERO_SNAP voxels (no vertex lands on a node).
pub const ZERO_SNAP: f64 = 1e-3;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grid {
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub voxel: f64,
    pub cells: [usize; 3],
}

impl Grid {
    /// `None` for a non-finite box or a non-positive voxel.
    pub fn new(min: [f64; 3], max: [f64; 3], voxel: f64) -> Option<Grid> {
        if !(voxel > 0.0 && voxel.is_finite()) || min.iter().chain(max.iter()).any(|v| !v.is_finite()) {
            return None;
        }
        let cells = |axis: usize| {
            let n = ((max[axis] - min[axis]) / voxel - 1e-9).ceil().max(1.0);
            if n < 4.0e9 {
                Some(n as usize)
            } else {
                None
            }
        };
        Some(Grid { min, max, voxel, cells: [cells(0)?, cells(1)?, cells(2)?] })
    }

    pub fn nodes(&self) -> [usize; 3] {
        [self.cells[0] + 1, self.cells[1] + 1, self.cells[2] + 1]
    }

    pub fn node_count(&self) -> u64 {
        self.nodes().iter().map(|&n| n as u64).product()
    }

    pub fn cell_count(&self) -> u64 {
        self.cells.iter().map(|&n| n as u64).product()
    }

    fn at(&self, axis: usize, index: usize) -> f64 {
        self.min[axis] + index as f64 * self.voxel
    }
}

/// Per tile: -1 proved full, +1 proved empty, 0 unproved.
pub struct Tiles {
    pub count: [usize; 3],
    sign: Vec<i8>,
}

impl Tiles {
    pub fn classify(evaluator: &Evaluator, grid: &Grid) -> Tiles {
        let count = [grid.cells[0].div_ceil(TILE), grid.cells[1].div_ceil(TILE), grid.cells[2].div_ceil(TILE)];
        let total = count[0] * count[1] * count[2];
        let sign: Vec<i8> = (0..total)
            .into_par_iter()
            .map_init(
                || IntervalScratch::new(evaluator.instrs.len()),
                |scratch, t| {
                    let tile = [t % count[0], (t / count[0]) % count[1], t / (count[0] * count[1])];
                    let lo = [tile[0] * TILE, tile[1] * TILE, tile[2] * TILE];
                    let hi = [0, 1, 2].map(|a| (lo[a] + TILE).min(grid.cells[a]));
                    let min = [0, 1, 2].map(|a| grid.at(a, lo[a]));
                    let max = [0, 1, 2].map(|a| grid.at(a, hi[a]));
                    let (low, high) = evaluator.interval(scratch, min, max);
                    if high < 0.0 {
                        -1
                    } else if low > 0.0 {
                        1
                    } else {
                        0
                    }
                },
            )
            .collect();
        Tiles { count, sign }
    }

    fn tile(&self, ti: usize, tj: usize, tk: usize) -> i8 {
        self.sign[ti + self.count[0] * (tj + self.count[1] * tk)]
    }

    /// Tiles that contain node `n` of an axis with `tiles` tiles (the tile it starts and the one it ends).
    fn candidates(n: usize, tiles: usize) -> impl Iterator<Item = usize> {
        let t = n / TILE;
        let before = if n.is_multiple_of(TILE) && t > 0 { Some(t - 1) } else { None };
        before.into_iter().chain((t < tiles).then_some(t))
    }

    #[cfg(test)]
    pub fn unproved(&self) -> usize {
        self.sign.iter().filter(|&&s| s == 0).count()
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PlaneStats {
    pub evaluated: u64,
    pub non_finite: u64,
}

impl PlaneStats {
    pub fn add(self, other: PlaneStats) -> PlaneStats {
        PlaneStats { evaluated: self.evaluated + other.evaluated, non_finite: self.non_finite + other.non_finite }
    }
}

/// Node values of plane `k` (nx * ny, x fastest) into `out`.
pub fn fill_plane(evaluator: &Evaluator, tiles: &Tiles, grid: &Grid, k: usize, out: &mut [f64]) -> PlaneStats {
    let nodes = grid.nodes();
    let snap = ZERO_SNAP * grid.voxel;
    out.par_chunks_mut(nodes[0])
        .enumerate()
        .map_init(
            || (vec![0.0; evaluator.instrs.len()], vec![0i8; tiles.count[0]]),
            |(registers, row_state), (j, row)| {
                for (ti, state) in row_state.iter_mut().enumerate() {
                    let mut combined = 1i8;
                    let mut unproved = false;
                    for tk in Tiles::candidates(k, tiles.count[2]) {
                        for tj in Tiles::candidates(j, tiles.count[1]) {
                            let s = tiles.tile(ti, tj, tk);
                            if s == 0 {
                                unproved = true;
                            } else {
                                combined = s;
                            }
                        }
                    }
                    *state = if unproved { 0 } else { combined };
                }
                let mut stats = PlaneStats::default();
                let (y, z) = (grid.at(1, j), grid.at(2, k));
                for (i, slot) in row.iter_mut().enumerate() {
                    let t0 = i / TILE;
                    let boundary = i.is_multiple_of(TILE) && t0 > 0;
                    let here = row_state.get(t0).copied();
                    let before = if boundary { row_state.get(t0 - 1).copied() } else { None };
                    if here == Some(0) || before == Some(0) {
                        let value = evaluator.value_at(registers, grid.at(0, i), y, z);
                        stats.evaluated += 1;
                        if value.is_finite() {
                            *slot = if value.abs() < snap { snap } else { value };
                        } else {
                            *slot = OUTSIDE;
                            stats.non_finite += 1;
                        }
                    } else {
                        let sign = here.or(before).unwrap_or(1);
                        *slot = f64::from(sign) * OUTSIDE;
                    }
                }
                stats
            },
        )
        .reduce(PlaneStats::default, PlaneStats::add)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tape::{Instr, Op, SLOTS};

    pub fn sphere(radius: f64) -> Evaluator {
        let step = |op: Op, a: i64, b: i64| Instr { op, args: [a, b, -1, -1, -1] };
        Evaluator {
            instrs: vec![
                Instr { op: Op::X, args: [-1; SLOTS] },
                Instr { op: Op::Y, args: [-1; SLOTS] },
                Instr { op: Op::Z, args: [-1; SLOTS] },
                step(Op::Square, 0, -1),
                step(Op::Square, 1, -1),
                step(Op::Square, 2, -1),
                step(Op::Add, 3, 4),
                step(Op::Add, 6, 5),
                step(Op::Sqrt, 7, -1),
                step(Op::Const, 0, -1),
                step(Op::Sub, 8, 9),
            ],
            output: 10,
            constants: vec![radius],
            meshes: vec![],
            struts: vec![],
            sampled: vec![],
        }
    }

    #[test]
    fn grid_cells_follow_the_engine_contract() {
        let g = Grid::new([0.0; 3], [10.0, 5.0, 0.0], 1.0).unwrap();
        assert_eq!(g.cells, [10, 5, 1], "a flat box still has one cell");
        assert_eq!(g.node_count(), 11 * 6 * 2);
        assert_eq!(g.cell_count(), 50);
        assert_eq!(Grid::new([0.0; 3], [1.0; 3], 1.0 / 3.0).unwrap().cells, [3, 3, 3], "the 1e-9 slack absorbs rounding");
        assert!(Grid::new([0.0; 3], [1.0; 3], 0.0).is_none());
        assert!(Grid::new([0.0; 3], [f64::NAN, 1.0, 1.0], 1.0).is_none());
        assert!(Grid::new([0.0; 3], [1.0e300, 1.0, 1.0], 1.0).is_none());
    }

    #[test]
    fn pruned_planes_equal_a_full_evaluation_where_it_matters() {
        let ev = sphere(3.0);
        let grid = Grid::new([-6.0; 3], [6.0; 3], 0.5).unwrap();
        let tiles = Tiles::classify(&ev, &grid);
        assert!(tiles.unproved() < tiles.count.iter().product(), "some tiles are proved");
        let nodes = grid.nodes();
        let mut plane = vec![0.0; nodes[0] * nodes[1]];
        let mut regs = vec![0.0; ev.instrs.len()];
        let mut proved = 0u64;
        for k in [0, 7, 12, 24] {
            let stats = fill_plane(&ev, &tiles, &grid, k, &mut plane);
            proved += (plane.len() as u64) - stats.evaluated;
            for (id, &value) in plane.iter().enumerate() {
                let (i, j) = (id % nodes[0], id / nodes[0]);
                let exact = ev.value_at(&mut regs, grid.at(0, i), grid.at(1, j), grid.at(2, k));
                if value.abs() < OUTSIDE {
                    assert!((value - exact).abs() <= ZERO_SNAP * grid.voxel * 2.0, "sampled node {i},{j},{k}");
                } else {
                    assert_eq!(value > 0.0, exact > 0.0, "the sign of a proved node is the sign of the field at {i},{j},{k}");
                }
            }
        }
        assert!(proved > 0, "pruning skipped some nodes");
    }

    #[test]
    fn non_finite_samples_become_outside_and_are_counted() {
        let mut ev = sphere(1.0);
        ev.instrs[8] = Instr { op: Op::Div, args: [7, 9, -1, -1, -1] };
        ev.constants = vec![0.0];
        let grid = Grid::new([0.0; 3], [2.0; 3], 1.0).unwrap();
        let tiles = Tiles::classify(&ev, &grid);
        let mut plane = vec![0.0; 9];
        let stats = fill_plane(&ev, &tiles, &grid, 1, &mut plane);
        assert!(stats.non_finite > 0);
        assert!(plane.iter().all(|&v| v == OUTSIDE || v == -OUTSIDE || v.is_finite()));
    }
}
