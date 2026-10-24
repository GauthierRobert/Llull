//! The route search of `searchRoute` (`autoRoute/search.ts`), step for step: A* over states (cell, incoming axis) with the same state keys,
//! move order, costs, heuristic, open-set order (f, h, i, j, k, axis) and stale-entry rule, run once per first-move candidate.
//!
//! Candidates: the start state has up to five first moves (every axis but the reverse of the port). Each is an A* of its own whose first
//! expansion makes only that move; the candidates run in parallel (rayon) and the best route wins by (cost, first-move axis index). A candidate
//! prunes entries that cannot beat the best route published so far in lexicographic (f, index) order, so a loser stops early. Pruning only drops
//! entries the winner would never pop before its goal, so the winner's route and expansion count do not depend on timing or on the thread
//! count; the budget is per candidate and a candidate that ran out of budget only makes the result `optimal: false` when its lower bound could
//! still beat the winner (VC-RTE-25: the TypeScript reference runs the same candidates one after the other).

use crate::obstacles::ObstacleTree;
use crate::problem::{Int3, RouteProblem, AXIS_VECTORS};
use crate::states::States;
use rayon::prelude::*;
use rayon::ThreadPool;
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    /// Lattice cells where the route bends, in route order.
    pub bend_cells: Vec<Int3>,
    pub cost: i64,
    /// Expansions of the winning candidate (its first expansion included).
    pub expansions: u64,
    /// Axis index (0..5) of the winning first move.
    pub candidate: u8,
    /// False when a candidate that ran out of budget could still hold a cheaper (or equal and earlier) route.
    pub optimal: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Found(Found),
    /// Expansions summed over the candidates.
    NoPath {
        expansions: u64,
    },
    Budget {
        expansions: u64,
    },
}

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

/// Packed (cost, candidate index) of the best route found so far; `NO_BOUND` = none. A cost above `MAX_PACKED_COST` is never published
/// (no pruning from it, still correct).
const NO_BOUND: u64 = u64::MAX;
const MAX_PACKED_COST: i64 = (1 << 60) - 1;

fn packed(cost: i64, index: u8) -> u64 {
    ((cost.clamp(0, MAX_PACKED_COST) as u64) << 3) | u64::from(index)
}

enum Candidate {
    Found { bend_cells: Vec<Int3>, cost: i64, expansions: u64 },
    Exhausted { expansions: u64 },
    Budget { expansions: u64, lower_bound: i64 },
}

impl Candidate {
    fn expansions(&self) -> u64 {
        match self {
            Candidate::Found { expansions, .. } | Candidate::Exhausted { expansions } | Candidate::Budget { expansions, .. } => *expansions,
        }
    }
}

/// The cell reached by move `next` from `cell` travelling `axis`, or None when it leaves the box or enters an obstacle.
fn target(p: &RouteProblem, tree: &ObstacleTree, cell: &Int3, axis: u8, next: u8) -> Option<Int3> {
    let step = if next == axis { 1 } else { p.min_leg_cells };
    let v = AXIS_VECTORS[usize::from(next)];
    let to = [cell[0] + v[0] * step, cell[1] + v[1] * step, cell[2] + v[2] * step];
    let inside = (0..3).all(|d| to[d] >= p.bounds.min[d] && to[d] <= p.bounds.max[d]);
    (inside && !tree.blocks(&p.cell_point(*cell), &p.cell_point(to))).then_some(to)
}

/// The open entry of move `next` out of (`cell`, `axis`) at cost `g`, and the cost `ng` of the state it reaches.
fn entry(p: &RouteProblem, cell: &Int3, axis: u8, g: i64, next: u8, to: &Int3) -> (OpenEntry, i64) {
    let step = if next == axis { 1 } else { p.min_leg_cells };
    let ng = g + move_cost(p, step, next, cell[2]) + if next == axis { 0 } else { p.bend_cost_um };
    let h = heuristic(p, to, next);
    (Reverse((ng + h, h, to[0], to[1], to[2], next, ng)), ng)
}

/// Axis indices of the valid first moves out of the start state, in axis order.
fn first_moves(p: &RouteProblem, tree: &ObstacleTree) -> Vec<u8> {
    let axis = p.from.axis;
    (0u8..6).filter(|&next| next != axis ^ 1 && target(p, tree, &[0, 0, 0], axis, next).is_some()).collect()
}

/// The candidate's open set and best-g store.
struct Frontier<'a> {
    heap: BinaryHeap<OpenEntry>,
    best: States,
    first: u8,
    bound: &'a AtomicU64,
}

impl Frontier<'_> {
    /// Queues the move unless a published route already beats it (lexicographic (f, index)) or a cheaper g reached the state.
    fn push(&mut self, from_key: u64, e: OpenEntry, to: &Int3, next: u8, ng: i64) {
        let Reverse((f, ..)) = e;
        let known = self.bound.load(Ordering::Relaxed);
        if known != NO_BOUND && packed(f, self.first) > known {
            return;
        }
        if self.best.improve(to, next, ng, from_key) {
            self.heap.push(e);
        }
    }
}

/// A* of one candidate: the start state is expanded once, with the move `first` only.
fn search_candidate(
    p: &RouteProblem,
    tree: &ObstacleTree,
    first: u8,
    max_expansions: u64,
    bound: &AtomicU64,
    report: &mut dyn FnMut(),
) -> Candidate {
    let (min, size) = (p.bounds.min, p.size());
    let key = |c: &Int3, axis: u8| -> u64 {
        ((((c[0] - min[0]) * size[1] + (c[1] - min[1])) * size[2] + (c[2] - min[2])) * 6 + i64::from(axis)) as u64
    };
    let start_axis = p.from.axis;
    let start_key = key(&[0, 0, 0], start_axis);
    let goal_key = key(&p.goal.cell, p.goal.axis);
    if max_expansions < 1 {
        return Candidate::Budget { expansions: 0, lower_bound: heuristic(p, &[0, 0, 0], start_axis) };
    }
    let mut open = Frontier { heap: BinaryHeap::new(), best: States::new(min, size), first, bound };
    open.best.improve(&[0, 0, 0], start_axis, 0, start_key);
    let mut expansions: u64 = 1;
    let Some(first_cell) = target(p, tree, &[0, 0, 0], start_axis, first) else {
        return Candidate::Exhausted { expansions };
    };
    let (e, ng) = entry(p, &[0, 0, 0], start_axis, 0, first, &first_cell);
    open.push(start_key, e, &first_cell, first, ng);
    while let Some(Reverse((f, _, i, j, k, axis, g))) = open.heap.pop() {
        let here = [i, j, k];
        let here_key = key(&here, axis);
        if open.best.get(&here, axis).map(|entry| entry.0) != Some(g) {
            continue;
        }
        if here_key == goal_key {
            if g <= MAX_PACKED_COST {
                bound.fetch_min(packed(g, first), Ordering::Relaxed);
            }
            return Candidate::Found { bend_cells: unwind(&open.best, goal_key, start_key, &min, &size), cost: g, expansions };
        }
        if expansions == max_expansions {
            return Candidate::Budget { expansions, lower_bound: f };
        }
        expansions += 1;
        if expansions.is_multiple_of(PROGRESS_EVERY) {
            report();
        }
        for next in 0u8..6 {
            if next == axis ^ 1 {
                continue;
            }
            if let Some(to) = target(p, tree, &here, axis, next) {
                let (e, ng) = entry(p, &here, axis, g, next, &to);
                open.push(here_key, e, &to, next, ng);
            }
        }
    }
    Candidate::Exhausted { expansions }
}

/// Searches every first-move candidate on the global rayon pool; `progress` gets the expansions done so far (all candidates) every
/// [`PROGRESS_EVERY`] expansions. `max_expansions` is the budget of each candidate, further capped at `max_total` / candidates.
pub fn search(p: &RouteProblem, max_expansions: u64, max_total: u64, progress: &mut dyn FnMut(u64)) -> Outcome {
    search_in(None, p, max_expansions, max_total, progress)
}

/// [`search`] on `pool` (None = the global pool): the result never depends on the pool's thread count.
pub fn search_in(
    pool: Option<&ThreadPool>,
    p: &RouteProblem,
    max_expansions: u64,
    max_total: u64,
    progress: &mut dyn FnMut(u64),
) -> Outcome {
    if p.from.axis == p.goal.axis && p.goal.cell == [0, 0, 0] {
        return Outcome::Found(Found { bend_cells: vec![], cost: 0, expansions: 0, candidate: p.from.axis, optimal: true });
    }
    let tree = ObstacleTree::build(&p.obstacles);
    let firsts = first_moves(p, &tree);
    // The memory guard is split evenly, so the budget of a candidate (and with it every result) stays independent of timing.
    let max_expansions = max_expansions.min(max_total / (firsts.len().max(1) as u64));
    let bound = AtomicU64::new(NO_BOUND);
    let (sender, receiver) = mpsc::channel::<()>();
    let (tree_ref, bound_ref, firsts_ref) = (&tree, &bound, &firsts);
    let outcomes: Vec<(u8, Candidate)> = std::thread::scope(|scope| {
        let worker = scope.spawn(move || {
            let run = || {
                firsts_ref
                    .par_iter()
                    .map_with(sender, |sender, &first| {
                        let mut report = || {
                            let _ = sender.send(());
                        };
                        (first, search_candidate(p, tree_ref, first, max_expansions, bound_ref, &mut report))
                    })
                    .collect::<Vec<_>>()
            };
            match pool {
                Some(pool) => pool.install(run),
                None => run(),
            }
        });
        let mut done = 0;
        for () in receiver {
            done += PROGRESS_EVERY;
            progress(done);
        }
        worker.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    });
    combine(&outcomes)
}

/// The best route over the candidates by (cost, first-move index); `optimal` unless a candidate that ran out of budget could still beat it.
fn combine(outcomes: &[(u8, Candidate)]) -> Outcome {
    let total: u64 = outcomes.iter().map(|(_, candidate)| candidate.expansions()).sum();
    let mut winner: Option<(i64, u8, &Vec<Int3>, u64)> = None;
    for (index, candidate) in outcomes {
        if let Candidate::Found { bend_cells, cost, expansions } = candidate {
            if winner.is_none_or(|(best, first, ..)| (*cost, *index) < (best, first)) {
                winner = Some((*cost, *index, bend_cells, *expansions));
            }
        }
    }
    let Some((cost, candidate, bend_cells, expansions)) = winner else {
        let stopped = outcomes.iter().any(|(_, c)| matches!(c, Candidate::Budget { .. }));
        return if stopped { Outcome::Budget { expansions: total } } else { Outcome::NoPath { expansions: total } };
    };
    let optimal =
        !outcomes.iter().any(|(index, c)| matches!(c, Candidate::Budget { lower_bound, .. } if (*lower_bound, *index) < (cost, candidate)));
    Outcome::Found(Found { bend_cells: bend_cells.clone(), cost, expansions, candidate, optimal })
}

fn unwind(best: &States, goal_key: u64, start_key: u64, min: &Int3, size: &Int3) -> Vec<Int3> {
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
        let (cell, axis) = decode(key);
        key = best.get(&cell, axis as u8).map_or(start_key, |entry| entry.1);
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

    fn pool(threads: usize) -> ThreadPool {
        rayon::ThreadPoolBuilder::new().num_threads(threads).build().expect("pool")
    }

    /// Seeded boxes between the SC-RTE-08 ports (LCG, 50 mm pitch), as the parity tests of the host draw them.
    fn seeded(seed: u64, count: usize) -> Vec<ObstacleBox> {
        let mut state = seed;
        let mut next = |n: u64| {
            state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
            (state % n) as i64
        };
        (0..count)
            .map(|index| {
                let min = [(500 + 50 * next(50)) * 1000, (-500 + 50 * next(60)) * 1000, (-200 + 50 * next(30)) * 1000];
                let size = [(100 + 50 * next(8)) * 1000, (100 + 50 * next(8)) * 1000, (100 + 50 * next(8)) * 1000];
                ObstacleBox { id: format!("b{index}"), min, max: [min[0] + size[0], min[1] + size[1], min[2] + size[2]] }
            })
            .collect()
    }

    #[test]
    fn free_space_route_has_manhattan_length_and_two_bends() {
        let route = found(search(&sc_rte_08(vec![]), 1_000_000, u64::MAX, &mut |_| {}));
        assert_eq!(route.bend_cells, vec![[56, 0, 0], [56, 40, 0]]);
        assert_eq!(route.cost, 5_600_000 + 2_000_000);
        assert!(route.optimal);
        // The winning candidate is the straight first move (+X); same count as the TypeScript reference (autoRoute.test.ts data).
        assert_eq!(route.candidate, 0);
        assert_eq!(route.expansions, 110);
    }

    #[test]
    fn a_box_on_the_first_leg_is_avoided_at_a_higher_cost() {
        let wall = ObstacleBox { id: "box".into(), min: [1_000_000, -500_000, -500_000], max: [1_100_000, 500_000, 500_000] };
        let route = found(search(&sc_rte_08(vec![wall.clone()]), 1_000_000, u64::MAX, &mut |_| {}));
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
        // Every candidate stops at its own budget: 3 expansions each, 5 candidates.
        assert_eq!(search(&sc_rte_08(vec![]), 3, u64::MAX, &mut |_| {}), Outcome::Budget { expansions: 15 });
        let wall = ObstacleBox { id: "wall".into(), min: [1_500_000, -9_000_000, -9_000_000], max: [1_510_000, 9_000_000, 9_000_000] };
        let mut p = sc_rte_08(vec![wall]);
        p.bounds = Bounds { min: [-2, -2, -2], max: [58, 42, 18] };
        assert!(matches!(search(&p, 10_000_000, u64::MAX, &mut |_| {}), Outcome::NoPath { expansions } if expansions > 0));
    }

    /// The U-shaped pocket of the TypeScript candidate tests (centre / size in mm, inflated by the DN100 reach 107.15 mm).
    fn pocket() -> Vec<ObstacleBox> {
        let reach = 107_150;
        [([1950, -1500, -1500], [2050, 1500, 1500]), ([500, 1400, -1500], [2000, 1500, 1500]), ([500, -1500, -1500], [2000, -1400, 1500])]
            .iter()
            .enumerate()
            .map(|(index, (min, max))| ObstacleBox {
                id: format!("pocket{index}"),
                min: std::array::from_fn(|d| min[d] * 1000 - reach),
                max: std::array::from_fn(|d| max[d] * 1000 + reach),
            })
            .collect()
    }

    #[test]
    fn the_result_does_not_depend_on_the_thread_count_or_the_run() {
        // Seeded boxes and the pocket, at budgets from tiny (losing candidates stop on budget) to ample.
        let mut problems: Vec<(String, RouteProblem)> =
            [1, 7, 42, 2026].iter().map(|&seed| (format!("seed {seed}"), sc_rte_08(seeded(seed, 12)))).collect();
        problems.push(("pocket".to_string(), sc_rte_08(pocket())));
        for (name, p) in &problems {
            for budget in [60, 150, 500, 984, 1_000_000] {
                let reference = search_in(Some(&pool(1)), p, budget, u64::MAX, &mut |_| {});
                for threads in [2, 5, 8] {
                    for _ in 0..3 {
                        assert_eq!(
                            search_in(Some(&pool(threads)), p, budget, u64::MAX, &mut |_| {}),
                            reference,
                            "{name}, budget {budget}, {threads} threads"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn a_losing_candidate_that_stops_on_budget_makes_the_pocket_route_unproven() {
        let p = sc_rte_08(pocket());
        let unproven = found(search(&p, 500, u64::MAX, &mut |_| {}));
        assert_eq!((unproven.candidate, unproven.expansions, unproven.optimal, unproven.cost), (2, 104, false, 8_600_000));
        let proven = found(search(&p, 2000, u64::MAX, &mut |_| {}));
        assert_eq!((proven.candidate, proven.expansions, proven.optimal, proven.cost), (0, 984, true, 8_600_000));
    }

    #[test]
    fn the_total_ceiling_is_split_evenly_over_the_candidates() {
        // Free space has 5 first moves: a total of 15 is 3 expansions each, the same as a per-candidate budget of 3.
        let p = sc_rte_08(vec![]);
        assert_eq!(search(&p, 1_000_000, 15, &mut |_| {}), search(&p, 3, u64::MAX, &mut |_| {}));
    }

    #[test]
    fn the_candidates_find_the_cost_of_an_unpartitioned_search() {
        // A first-move partition keeps the optimum: the best candidate cost is the cheapest cost any single candidate reaches.
        let p = sc_rte_08(seeded(42, 12));
        let best = found(search(&p, 1_000_000, u64::MAX, &mut |_| {}));
        let tree = ObstacleTree::build(&p.obstacles);
        let costs: Vec<i64> = first_moves(&p, &tree)
            .into_iter()
            .filter_map(|first| match search_candidate(&p, &tree, first, 1_000_000, &AtomicU64::new(NO_BOUND), &mut || {}) {
                Candidate::Found { cost, .. } => Some(cost),
                _ => None,
            })
            .collect();
        assert_eq!(costs.iter().min().copied(), Some(best.cost));
        assert!(best.optimal);
    }

    #[test]
    fn a_candidate_out_of_budget_that_could_still_win_makes_the_result_unproven() {
        let route = |cost| Candidate::Found { bend_cells: vec![], cost, expansions: 5 };
        let stopped = |lower_bound| Candidate::Budget { expansions: 9, lower_bound };
        assert!(!found(combine(&[(0, route(100)), (1, stopped(99))])).optimal);
        assert!(
            found(combine(&[(0, route(100)), (1, stopped(100)), (2, stopped(101))])).optimal,
            "a later index at an equal bound cannot win the tie"
        );
        assert!(!found(combine(&[(0, stopped(100)), (1, route(100))])).optimal, "an earlier index at an equal bound could win the tie");
    }

    #[test]
    fn a_start_state_that_is_the_goal_is_the_straight_route() {
        let mut p = sc_rte_08(vec![]);
        p.goal = Goal { cell: [0, 0, 0], axis: 0 };
        let route = found(search(&p, 10, u64::MAX, &mut |_| {}));
        assert_eq!((route.bend_cells.len(), route.cost, route.expansions, route.candidate), (0, 0, 0, 0));
    }

    #[test]
    fn the_bend_lower_bound_counts_needed_directions() {
        assert_eq!(min_bends(&[0, 0, 0], 0, &[56, 40, 16], 4), 2);
        assert_eq!(min_bends(&[56, 40, 0], 4, &[56, 40, 16], 4), 0);
        assert_eq!(min_bends(&[0, 0, 0], 2, &[5, 0, 0], 0), 1);
    }
}
