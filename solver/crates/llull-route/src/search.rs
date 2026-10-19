//! The A* of `searchRoute` (`autoRoute/search.ts`), step for step: same state keys, move order, costs, heuristic, open-set
//! order (f, h, i, j, k, axis) and stale-entry rule, so the native and reference searches expand the same states (VC-RTE-25).

use crate::obstacles::ObstacleTree;
use crate::problem::{Int3, RouteProblem, AXIS_VECTORS};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::hash::{BuildHasherDefault, Hasher};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    /// Lattice cells where the route bends, in route order.
    pub bend_cells: Vec<Int3>,
    pub cost: i64,
    pub expansions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Found(Found),
    NoPath { expansions: u64 },
    Budget { expansions: u64 },
}

/// Multiplicative hash of the dense integer state keys (no SipHash: keys are not attacker-controlled).
#[derive(Default)]
struct KeyHasher(u64);

impl Hasher for KeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.write_u64(u64::from(byte));
        }
    }
    fn write_u64(&mut self, value: u64) {
        self.0 = (self.0.rotate_left(5) ^ value).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
}

type StateMap = HashMap<u64, (i64, u64), BuildHasherDefault<KeyHasher>>;

/// Open-set entry (f, h, i, j, k, axis, g), popped smallest first; g follows from (f, h) for a given state.
type OpenEntry = Reverse<(i64, i64, i64, i64, i64, u8, i64)>;

/// Lower bound on the bends left: every signed direction still needed plus the arrival one; the current one is free.
pub fn min_bends(cell: &Int3, axis: u8, goal: &Int3, arrival: u8) -> i64 {
    let mut needed: u32 = 1 << arrival;
    for d in 0..3 {
        let delta = goal[d] - cell[d];
        if delta != 0 {
            needed |= 1 << (2 * d + usize::from(delta < 0));
        }
    }
    i64::from(needed.count_ones()) - i64::from((needed >> axis) & 1)
}

pub fn heuristic(p: &RouteProblem, cell: &Int3, axis: u8) -> i64 {
    let g = &p.goal.cell;
    let cells = (g[0] - cell[0]).abs() + (g[1] - cell[1]).abs() + (g[2] - cell[2]).abs();
    cells * p.cell_um + p.bend_cost_um * min_bends(cell, axis, g, p.goal.axis)
}

fn move_cost(p: &RouteProblem, cells: i64, axis: u8, k: i64) -> i64 {
    let off = axis < 4 && !p.preferred_k.is_empty() && !p.preferred_k.contains(&k);
    cells * p.cell_um + if off { cells * p.off_elevation_penalty_per_cell_um } else { 0 }
}

/// Expansions between two `progress` callbacks.
pub const PROGRESS_EVERY: u64 = 1 << 16;

/// Runs A* until the goal is popped, the open set empties or `max_expansions` states were expanded.
pub fn search(p: &RouteProblem, max_expansions: u64, progress: &mut dyn FnMut(u64)) -> Outcome {
    let tree = ObstacleTree::build(&p.obstacles);
    let (min, size) = (p.bounds.min, p.size());
    let key = |c: &Int3, axis: u8| -> u64 {
        ((((c[0] - min[0]) * size[1] + (c[1] - min[1])) * size[2] + (c[2] - min[2])) * 6 + i64::from(axis)) as u64
    };
    let inside = |c: &Int3| (0..3).all(|d| c[d] >= p.bounds.min[d] && c[d] <= p.bounds.max[d]);
    let mut best: StateMap = HashMap::default();
    let mut heap: BinaryHeap<OpenEntry> = BinaryHeap::new();
    let start_axis = p.from.axis;
    let start_key = key(&[0, 0, 0], start_axis);
    best.insert(start_key, (0, start_key));
    let h0 = heuristic(p, &[0, 0, 0], start_axis);
    heap.push(Reverse((h0, h0, 0, 0, 0, start_axis, 0)));
    let goal_key = key(&p.goal.cell, p.goal.axis);
    let mut expansions: u64 = 0;
    while let Some(Reverse((_, _, i, j, k, axis, g))) = heap.pop() {
        let here_cell = [i, j, k];
        let here_key = key(&here_cell, axis);
        if best.get(&here_key).map(|entry| entry.0) != Some(g) {
            continue;
        }
        if here_key == goal_key {
            return Outcome::Found(Found { bend_cells: unwind(&best, goal_key, start_key, &min, &size), cost: g, expansions });
        }
        if expansions == max_expansions {
            return Outcome::Budget { expansions };
        }
        expansions += 1;
        if expansions.is_multiple_of(PROGRESS_EVERY) {
            progress(expansions);
        }
        let here = p.cell_point(here_cell);
        for next in 0u8..6 {
            if next == axis ^ 1 {
                continue;
            }
            let step = if next == axis { 1 } else { p.min_leg_cells };
            let v = AXIS_VECTORS[usize::from(next)];
            let cell = [i + v[0] * step, j + v[1] * step, k + v[2] * step];
            if !inside(&cell) || tree.blocks(&here, &p.cell_point(cell)) {
                continue;
            }
            let ng = g + move_cost(p, step, next, k) + if next == axis { 0 } else { p.bend_cost_um };
            let next_key = key(&cell, next);
            if best.get(&next_key).is_some_and(|entry| entry.0 <= ng) {
                continue;
            }
            best.insert(next_key, (ng, here_key));
            let h = heuristic(p, &cell, next);
            heap.push(Reverse((ng + h, h, cell[0], cell[1], cell[2], next, ng)));
        }
    }
    Outcome::NoPath { expansions }
}

fn unwind(best: &StateMap, goal_key: u64, start_key: u64, min: &Int3, size: &Int3) -> Vec<Int3> {
    let decode = |key: u64| -> (Int3, u64) {
        let axis = key % 6;
        let mut rest = (key / 6) as i64;
        let k = rest % size[2];
        rest /= size[2];
        let j = rest % size[1];
        let i = rest / size[1];
        ([i + min[0], j + min[1], k + min[2]], axis)
    };
    let mut states = vec![decode(goal_key)];
    let mut key = goal_key;
    while key != start_key {
        key = best.get(&key).map_or(start_key, |entry| entry.1);
        states.push(decode(key));
    }
    states.reverse();
    states.windows(2).filter(|pair| pair[1].1 != pair[0].1).map(|pair| pair[0].0).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::problem::{Bounds, Goal, ObstacleBox, ProblemEnd};

    /// SC-RTE-08 as `route_problem` builds it: grid 50 mm, stubs 200 mm, bend cost 1000 mm, minimum leg 7 cells.
    pub(crate) fn sc_rte_08(obstacles: Vec<ObstacleBox>) -> RouteProblem {
        RouteProblem {
            version: 1,
            cell_um: 50_000,
            origin_um: [200_000, 0, 0],
            bounds: Bounds { min: [-40, -40, -40], max: [96, 80, 56] },
            from: ProblemEnd { point_um: [0, 0, 0], axis: 0, stub_um: 200_000 },
            to: ProblemEnd { point_um: [3_000_000, 2_000_000, 1_000_000], axis: 4, stub_um: 200_000 },
            goal: Goal { cell: [56, 40, 16], axis: 4 },
            min_leg_cells: 7,
            bend_cost_um: 1_000_000,
            preferred_k: vec![],
            off_elevation_penalty_per_cell_um: 0,
            obstacles,
        }
    }

    fn found(outcome: Outcome) -> Found {
        match outcome {
            Outcome::Found(found) => found,
            other => panic!("expected a route, got {other:?}"),
        }
    }

    #[test]
    fn free_space_route_has_manhattan_length_and_two_bends() {
        let route = found(search(&sc_rte_08(vec![]), 1_000_000, &mut |_| {}));
        assert_eq!(route.bend_cells, vec![[56, 0, 0], [56, 40, 0]]);
        assert_eq!(route.cost, 5_600_000 + 2_000_000);
        // Same count as the TypeScript reference on the same problem (tests/unit/plant/piping/autoRoute.test.ts data).
        assert_eq!(route.expansions, 110);
    }

    #[test]
    fn a_box_on_the_first_leg_is_avoided_at_a_higher_cost() {
        let wall = ObstacleBox { id: "box".into(), min: [1_000_000, -500_000, -500_000], max: [1_100_000, 500_000, 500_000] };
        let route = found(search(&sc_rte_08(vec![wall.clone()]), 1_000_000, &mut |_| {}));
        assert!(route.cost > 7_600_000);
        let p = sc_rte_08(vec![wall]);
        let mut points = vec![p.cell_point([0, 0, 0])];
        points.extend(route.bend_cells.iter().map(|&c| p.cell_point(c)));
        points.push(p.cell_point(p.goal.cell));
        let tree = ObstacleTree::build(&p.obstacles);
        assert!(points.windows(2).all(|w| !tree.blocks(&w[0], &w[1])));
    }

    #[test]
    fn budget_and_no_path_are_reported_with_their_expansions() {
        assert_eq!(search(&sc_rte_08(vec![]), 3, &mut |_| {}), Outcome::Budget { expansions: 3 });
        let wall = ObstacleBox { id: "wall".into(), min: [1_500_000, -9_000_000, -9_000_000], max: [1_510_000, 9_000_000, 9_000_000] };
        let mut p = sc_rte_08(vec![wall]);
        p.bounds = Bounds { min: [-2, -2, -2], max: [58, 42, 18] };
        assert!(matches!(search(&p, 10_000_000, &mut |_| {}), Outcome::NoPath { expansions } if expansions > 0));
    }

    #[test]
    fn the_bend_lower_bound_counts_needed_directions() {
        assert_eq!(min_bends(&[0, 0, 0], 0, &[56, 40, 16], 4), 2);
        assert_eq!(min_bends(&[56, 40, 0], 4, &[56, 40, 16], 4), 0);
        assert_eq!(min_bends(&[0, 0, 0], 2, &[5, 0, 0], 0), 1);
    }
}
