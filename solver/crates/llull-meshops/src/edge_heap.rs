//! The collapse queue of the decimation: an indexed 4-ary min-heap with one entry per edge, ordered by (cost, a, b). The TypeScript engine pushes a
//! fresh entry every time an edge is touched and skips the stale ones when they surface (24 million pushes and 22 million pops for 600 000 collapses
//! on 1.3 M triangles); here an edge is updated in place and removed when it goes, so the queue holds exactly the entries the other one would still
//! consider valid and pops them in the same order.

/// An edge `a` < `b` and the quadric cost of collapsing it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Candidate {
    pub cost: f64,
    pub a: u32,
    pub b: u32,
}

/// Packs an edge so that comparing keys compares (a, b).
fn key(a: u32, b: u32) -> u64 {
    (u64::from(a) << 32) | u64::from(b)
}

/// The cost an edge is ordered by: NaN is +infinity.
fn rank(cost: f64) -> f64 {
    if cost.is_nan() {
        f64::INFINITY
    } else {
        cost
    }
}

const EMPTY: u64 = u64::MAX;

/// Open-addressing table from a packed edge to its id (linear probing, deletion by shifting back: no tombstones). Edges are `a < b`, so
/// `u64::MAX` is never a key.
#[derive(Default)]
struct EdgeIds {
    slots: Vec<(u64, u32)>,
    len: usize,
}

impl EdgeIds {
    fn with_capacity(edges: usize) -> Self {
        Self { slots: vec![(EMPTY, 0); (edges * 2).next_power_of_two().max(16)], len: 0 }
    }

    fn mask(&self) -> usize {
        self.slots.len() - 1
    }

    fn home(&self, edge: u64) -> usize {
        (edge.wrapping_mul(0x9e37_79b9_7f4a_7c15) >> (64 - self.slots.len().trailing_zeros())) as usize
    }

    fn get(&self, edge: u64) -> Option<u32> {
        if self.slots.is_empty() {
            return None;
        }
        let mut i = self.home(edge);
        loop {
            match self.slots[i] {
                (EMPTY, _) => return None,
                (k, id) if k == edge => return Some(id),
                _ => i = (i + 1) & self.mask(),
            }
        }
    }

    fn insert(&mut self, edge: u64, id: u32) {
        if self.slots.is_empty() || (self.len + 1) * 2 > self.slots.len() {
            let old = std::mem::take(&mut self.slots);
            self.slots = vec![(EMPTY, 0); (old.len() * 2).max(16)];
            self.len = 0;
            for (k, v) in old.into_iter().filter(|&(k, _)| k != EMPTY) {
                self.insert(k, v);
            }
        }
        let mut i = self.home(edge);
        while self.slots[i].0 != EMPTY {
            i = (i + 1) & self.mask();
        }
        self.slots[i] = (edge, id);
        self.len += 1;
    }

    fn remove(&mut self, edge: u64) -> Option<u32> {
        if self.slots.is_empty() {
            return None;
        }
        let mut hole = self.home(edge);
        loop {
            match self.slots[hole] {
                (EMPTY, _) => return None,
                (k, _) if k == edge => break,
                _ => hole = (hole + 1) & self.mask(),
            }
        }
        let id = self.slots[hole].1;
        let mut next = hole;
        loop {
            next = (next + 1) & self.mask();
            let (k, _) = self.slots[next];
            if k == EMPTY {
                break;
            }
            // an entry may fill the hole unless its home lies cyclically in (hole, next]
            if (next.wrapping_sub(self.home(k)) & self.mask()) >= (next.wrapping_sub(hole) & self.mask()) {
                self.slots[hole] = self.slots[next];
                hole = next;
            }
        }
        self.slots[hole] = (EMPTY, 0);
        self.len -= 1;
        Some(id)
    }
}

#[derive(Clone, Copy)]
struct Node {
    cost: f64,
    id: u32,
}

/// What the heap keeps per edge id.
#[derive(Clone, Copy, Default)]
struct Meta {
    edge: u64,
    position: u32,
}

const ARITY: usize = 4;

#[derive(Default)]
pub struct EdgeHeap {
    nodes: Vec<Node>,
    meta: Vec<Meta>,
    ids: EdgeIds,
    free: Vec<u32>,
}

impl EdgeHeap {
    /// A queue holding `edges`, which must be distinct (a < b); O(n) instead of one sift per edge.
    pub fn from_edges(edges: &[Candidate]) -> Self {
        let mut heap = Self {
            nodes: edges.iter().enumerate().map(|(id, c)| Node { cost: c.cost, id: id as u32 }).collect(),
            meta: edges.iter().enumerate().map(|(id, c)| Meta { edge: key(c.a, c.b), position: id as u32 }).collect(),
            ids: EdgeIds::with_capacity(edges.len()),
            free: Vec::new(),
        };
        for (id, c) in edges.iter().enumerate() {
            heap.ids.insert(key(c.a, c.b), id as u32);
        }
        for at in (0..edges.len() / ARITY + 1).rev() {
            if at < heap.nodes.len() {
                heap.sift_down(at);
            }
        }
        heap
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Whether `x` is cheaper than `y`: lower cost first, then lower `a`, then lower `b` (the TypeScript order). A NaN cost counts as +infinity (a
    /// total order, so the pop order does not depend on the shape of the heap).
    fn less(&self, x: Node, y: Node) -> bool {
        let (cx, cy) = (rank(x.cost), rank(y.cost));
        cx < cy || (cx == cy && self.meta[x.id as usize].edge < self.meta[y.id as usize].edge)
    }

    /// Sets the cost of the edge `a` < `b`, adding it when absent.
    pub fn upsert(&mut self, a: u32, b: u32, cost: f64) {
        debug_assert!(a < b);
        if let Some(id) = self.ids.get(key(a, b)) {
            let at = self.meta[id as usize].position as usize;
            self.nodes[at].cost = cost;
            self.restore(at);
            return;
        }
        let id = self.free.pop().unwrap_or_else(|| {
            self.meta.push(Meta::default());
            (self.meta.len() - 1) as u32
        });
        self.meta[id as usize].edge = key(a, b);
        self.ids.insert(key(a, b), id);
        self.nodes.push(Node { cost, id });
        let at = self.nodes.len() - 1;
        self.sift_up(at);
    }

    /// Removes the edge `a` < `b`; false when it is not queued.
    pub fn remove(&mut self, a: u32, b: u32) -> bool {
        debug_assert!(a < b);
        let Some(id) = self.ids.remove(key(a, b)) else { return false };
        self.free.push(id);
        let at = self.meta[id as usize].position as usize;
        let Some(last) = self.nodes.pop() else { return true };
        if at < self.nodes.len() {
            self.nodes[at] = last;
            self.restore(at);
        }
        true
    }

    /// The cheapest edge, removed.
    pub fn pop(&mut self) -> Option<Candidate> {
        let top = *self.nodes.first()?;
        let edge = self.meta[top.id as usize].edge;
        let (a, b) = ((edge >> 32) as u32, edge as u32);
        self.remove(a, b);
        Some(Candidate { cost: top.cost, a, b })
    }

    fn restore(&mut self, at: usize) {
        if at > 0 && self.less(self.nodes[at], self.nodes[(at - 1) / ARITY]) {
            self.sift_up(at);
        } else {
            self.sift_down(at);
        }
    }

    fn sift_up(&mut self, mut at: usize) {
        let node = self.nodes[at];
        while at > 0 {
            let parent = (at - 1) / ARITY;
            if !self.less(node, self.nodes[parent]) {
                break;
            }
            self.nodes[at] = self.nodes[parent];
            self.meta[self.nodes[at].id as usize].position = at as u32;
            at = parent;
        }
        self.nodes[at] = node;
        self.meta[node.id as usize].position = at as u32;
    }

    fn sift_down(&mut self, mut at: usize) {
        let node = self.nodes[at];
        loop {
            let first = at * ARITY + 1;
            if first >= self.nodes.len() {
                break;
            }
            let end = (first + ARITY).min(self.nodes.len());
            let mut best = first;
            for child in first + 1..end {
                if self.less(self.nodes[child], self.nodes[best]) {
                    best = child;
                }
            }
            if !self.less(self.nodes[best], node) {
                break;
            }
            self.nodes[at] = self.nodes[best];
            self.meta[self.nodes[at].id as usize].position = at as u32;
            at = best;
        }
        self.nodes[at] = node;
        self.meta[node.id as usize].position = at as u32;
    }
}

#[cfg(test)]
mod tests {
    use super::{Candidate, EdgeHeap};
    use std::collections::BTreeMap;

    /// xorshift: a fixed pseudo-random stream, so the tests are deterministic.
    fn stream(seed: u64) -> impl FnMut() -> u64 {
        let mut state = seed;
        move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        }
    }

    use super::rank;

    /// The same candidate, bit for bit (NaN equals NaN here).
    fn same(x: Option<Candidate>, y: Option<Candidate>) -> bool {
        x.map(|c| (c.a, c.b, c.cost.to_bits())) == y.map(|c| (c.a, c.b, c.cost.to_bits()))
    }

    fn cheapest(model: &BTreeMap<(u32, u32), f64>) -> Option<Candidate> {
        model.iter().map(|(&(a, b), &cost)| Candidate { cost, a, b }).reduce(|best, c| {
            if rank(c.cost) < rank(best.cost) || (rank(c.cost) == rank(best.cost) && (c.a, c.b) < (best.a, best.b)) {
                c
            } else {
                best
            }
        })
    }

    #[test]
    fn pops_by_cost_then_by_vertex_ids() {
        let mut heap = EdgeHeap::default();
        for (a, b, cost) in [(3, 4, 2.0), (1, 9, 1.0), (1, 2, 1.0), (0, 5, 3.0), (2, 3, 2.0)] {
            heap.upsert(a, b, cost);
        }
        let order: Vec<(u32, u32)> = std::iter::from_fn(|| heap.pop()).map(|c| (c.a, c.b)).collect();
        assert_eq!(order, [(1, 2), (1, 9), (2, 3), (3, 4), (0, 5)]);
        assert!(heap.is_empty() && heap.pop().is_none());
    }

    #[test]
    fn a_nan_cost_pops_with_the_infinite_ones_ordered_by_vertex_ids_whatever_the_insertion_order() {
        let costs = [(5, 6, f64::NAN), (1, 2, f64::INFINITY), (3, 4, f64::NAN), (7, 8, 2.0), (0, 9, f64::NAN)];
        for rotation in 0..costs.len() {
            let mut heap = EdgeHeap::default();
            for k in 0..costs.len() {
                let (a, b, cost) = costs[(k + rotation) % costs.len()];
                heap.upsert(a, b, cost);
            }
            let order: Vec<(u32, u32)> = std::iter::from_fn(|| heap.pop()).map(|c| (c.a, c.b)).collect();
            assert_eq!(order, [(7, 8), (0, 9), (1, 2), (3, 4), (5, 6)]);
        }
    }

    #[test]
    fn upsert_moves_an_edge_both_ways_and_remove_reports_whether_it_was_queued() {
        let mut heap = EdgeHeap::default();
        for a in 0..20u32 {
            heap.upsert(a, a + 1, f64::from(a));
        }
        heap.upsert(15, 16, -1.0);
        heap.upsert(0, 1, 100.0);
        assert!(heap.remove(3, 4) && !heap.remove(3, 4) && !heap.remove(50, 51));
        assert_eq!(heap.len(), 19);
        assert_eq!(heap.pop(), Some(Candidate { cost: -1.0, a: 15, b: 16 }));
        assert_eq!(heap.pop(), Some(Candidate { cost: 1.0, a: 1, b: 2 }));
        let rest: Vec<f64> = std::iter::from_fn(|| heap.pop()).map(|c| c.cost).collect();
        assert!(rest.windows(2).all(|w| w[0] <= w[1]) && rest.last() == Some(&100.0));
    }

    #[test]
    fn a_bulk_built_queue_pops_like_one_built_edge_by_edge() {
        let mut next = stream(7);
        let edges: Vec<Candidate> =
            (0..3000u32).map(|i| Candidate { cost: (next() % 50) as f64, a: i, b: i + 1 + (next() % 9) as u32 }).collect();
        let mut bulk = EdgeHeap::from_edges(&edges);
        let mut one_by_one = EdgeHeap::default();
        for c in &edges {
            one_by_one.upsert(c.a, c.b, c.cost);
        }
        assert_eq!(bulk.len(), 3000);
        for _ in 0..3000 {
            assert_eq!(bulk.pop(), one_by_one.pop());
        }
        assert!(bulk.pop().is_none());
    }

    #[test]
    fn follows_a_sorted_map_with_nan_signed_zero_and_infinity_through_fifty_thousand_random_operations() {
        let mut next = stream(0x9e37_79b9_7f4a_7c15);
        let mut heap = EdgeHeap::default();
        let mut model: BTreeMap<(u32, u32), f64> = BTreeMap::new();
        for _ in 0..50_000 {
            let (a, b) = ((next() % 60) as u32, (next() % 60) as u32 + 61);
            match next() % 4 {
                0 => assert_eq!(heap.remove(a, b), model.remove(&(a, b)).is_some()),
                1 => {
                    let expected = cheapest(&model);
                    assert!(same(heap.pop(), expected));
                    if let Some(c) = expected {
                        model.remove(&(c.a, c.b));
                    }
                }
                _ => {
                    // few distinct costs: many ties, settled by the vertex ids; NaN is +infinity, -0 and +0 tie
                    let cost = [0.0, 1.0, 2.0, f64::NAN, -0.0, f64::INFINITY, 3.0][(next() % 7) as usize];
                    heap.upsert(a, b, cost);
                    model.insert((a, b), cost);
                }
            }
            assert_eq!(heap.len(), model.len());
        }
    }
}
