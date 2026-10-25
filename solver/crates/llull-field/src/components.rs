//! Connected components of the node sign grid: twin of `components.ts` + the `components` request of `tsEngine.ts`. Solid and void nodes are both
//! 14-connected (the edges of the Kuhn tetrahedra); components are numbered in scan order (x fastest) and walked breadth first in the same
//! neighbour order, so the representative `point` is the same node. A void touching no boundary node is enclosed.

use crate::eval::Evaluator;
use crate::sampling::{fill_plane, Grid, Tiles, ZERO_SNAP};
use llull_jsmath::pow;

#[derive(Debug, Clone, PartialEq)]
pub struct Component {
    pub voxels: u64,
    pub volume: f64,
    pub point: [f64; 3],
    pub enclosed: bool,
}

const VISITED: u8 = 2;

/// 1 where the node is solid: value < 2 * ZERO_SNAP * voxel and, with a region, the region value likewise.
pub fn solid_nodes(main: &Evaluator, region: Option<&Evaluator>, grid: &Grid) -> Vec<u8> {
    let nodes = grid.nodes();
    let slab = nodes[0] * nodes[1];
    let closed = 2.0 * ZERO_SNAP * grid.voxel;
    let main_tiles = Tiles::classify(main, grid);
    let region_tiles = region.map(|r| Tiles::classify(r, grid));
    let mut inside = vec![0u8; slab * nodes[2]];
    let mut plane = vec![0.0; slab];
    let mut region_plane = vec![0.0; if region.is_some() { slab } else { 0 }];
    for k in 0..nodes[2] {
        fill_plane(main, &main_tiles, grid, k, &mut plane);
        if let (Some(r), Some(t)) = (region, &region_tiles) {
            fill_plane(r, t, grid, k, &mut region_plane);
        }
        for id in 0..slab {
            let solid = plane[id] < closed && (region.is_none() || region_plane[id] < closed);
            inside[k * slab + id] = u8::from(solid);
        }
    }
    inside
}

fn label(inside: &mut [u8], nodes: [usize; 3], solid: bool, grid: &Grid) -> Vec<Component> {
    let [sx, sy, sz] = nodes;
    let wanted = u8::from(solid);
    let mut queue: Vec<u32> = Vec::new();
    let mut found = Vec::new();
    for start in 0..inside.len() {
        if inside[start] != wanted {
            continue;
        }
        queue.clear();
        queue.push(start as u32);
        inside[start] |= VISITED;
        let mut head = 0;
        let mut touches_boundary = false;
        while head < queue.len() {
            let id = queue[head] as usize;
            head += 1;
            let (i, j, k) = (id % sx, (id / sx) % sy, id / (sx * sy));
            if i == 0 || j == 0 || k == 0 || i == sx - 1 || j == sy - 1 || k == sz - 1 {
                touches_boundary = true;
            }
            for dk in -1i64..=1 {
                for dj in -1i64..=1 {
                    for di in -1i64..=1 {
                        if di == 0 && dj == 0 && dk == 0 {
                            continue;
                        }
                        if di.min(dj).min(dk) < 0 && di.max(dj).max(dk) > 0 {
                            continue;
                        }
                        let (ni, nj, nk) = (i as i64 + di, j as i64 + dj, k as i64 + dk);
                        if ni < 0 || nj < 0 || nk < 0 || ni >= sx as i64 || nj >= sy as i64 || nk >= sz as i64 {
                            continue;
                        }
                        let next = ni as usize + sx * (nj as usize + sy * nk as usize);
                        if inside[next] != wanted {
                            continue;
                        }
                        inside[next] |= VISITED;
                        queue.push(next as u32);
                    }
                }
            }
        }
        found.push(Component {
            voxels: queue.len() as u64,
            volume: queue.len() as f64 * pow(grid.voxel, 3.0),
            point: representative(&queue, nodes, grid),
            enclosed: !solid && !touches_boundary,
        });
    }
    found
}

fn representative(members: &[u32], nodes: [usize; 3], grid: &Grid) -> [f64; 3] {
    let at = |id: u32| {
        let id = id as usize;
        [(id % nodes[0]) as f64, ((id / nodes[0]) % nodes[1]) as f64, (id / (nodes[0] * nodes[1])) as f64]
    };
    let mut sum = [0.0; 3];
    for &id in members {
        let p = at(id);
        for axis in 0..3 {
            sum[axis] += p[axis];
        }
    }
    let centre = sum.map(|s| s / members.len() as f64);
    let mut best = members[0];
    let mut best_distance = f64::INFINITY;
    for &id in members {
        let p = at(id);
        let d = (p[0] - centre[0]) * (p[0] - centre[0]) + (p[1] - centre[1]) * (p[1] - centre[1]) + (p[2] - centre[2]) * (p[2] - centre[2]);
        if d < best_distance {
            best_distance = d;
            best = id;
        }
    }
    let p = at(best);
    [grid.min[0] + p[0] * grid.voxel, grid.min[1] + p[1] * grid.voxel, grid.min[2] + p[2] * grid.voxel]
}

/// Solid and void components of the clipped solid on the grid nodes.
pub fn components(main: &Evaluator, region: Option<&Evaluator>, grid: &Grid) -> (Vec<Component>, Vec<Component>) {
    let nodes = grid.nodes();
    let mut inside = solid_nodes(main, region, grid);
    let solids = label(&mut inside, nodes, true, grid);
    let voids = label(&mut inside, nodes, false, grid);
    (solids, voids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tape::Op;
    use crate::testkit::Tape;

    /// Ball of radius 1.5 at x = 2 with a cavity of radius 0.5, and a plain ball at x = 8.
    fn pieces() -> Evaluator {
        let mut t = Tape::new();
        let shell = t.ball([2.0, 2.0, 2.0], 1.5);
        let cavity = t.ball([2.0, 2.0, 2.0], 0.5);
        let hollow_field = t.un(Op::Neg, cavity);
        let hollow = t.bin(Op::Max, shell, hollow_field);
        let other = t.ball([8.0, 2.0, 2.0], 1.5);
        let both = t.bin(Op::Min, hollow, other);
        t.finish(both)
    }

    #[test]
    fn counts_solids_voids_and_the_enclosed_cavity() {
        let grid = Grid::new([-1.0; 3], [10.0, 5.0, 5.0], 0.25).unwrap();
        let (solids, voids) = components(&pieces(), None, &grid);
        assert_eq!(solids.len(), 2);
        assert_eq!(voids.len(), 2);
        assert!(solids.iter().all(|s| !s.enclosed));
        let cavity: Vec<&Component> = voids.iter().filter(|v| v.enclosed).collect();
        assert_eq!(cavity.len(), 1, "one enclosed void");
        assert!((cavity[0].point[0] - 2.0).abs() < 0.3 && (cavity[0].point[1] - 2.0).abs() < 0.3, "point {:?}", cavity[0].point);
        assert!((cavity[0].volume - 4.0 / 3.0 * std::f64::consts::PI * 0.125).abs() < 0.2, "cavity volume {}", cavity[0].volume);
        assert_eq!(cavity[0].voxels as f64 * 0.25_f64.powi(3), cavity[0].volume);
    }

    #[test]
    fn a_region_clips_the_nodes_that_count() {
        let grid = Grid::new([-1.0; 3], [10.0, 5.0, 5.0], 0.25).unwrap();
        let mut t = Tape::new();
        let x = t.x();
        let five = t.c(5.0);
        let left_half = t.bin(Op::Sub, x, five);
        let region = t.finish(left_half);
        let (solids, _) = components(&pieces(), Some(&region), &grid);
        assert_eq!(solids.len(), 1, "only the first ball is inside the region");
    }
}
