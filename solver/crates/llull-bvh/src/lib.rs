//! Deterministic bounding-box tree and closest-point queries (RS1 §2, `llull-bvh`).
//!
//! The tree and the nearest-leaf search reproduce `packages/domain-cae/src/thermomech/mapping.ts` exactly: median split on the axis of
//! largest extent (ties: lower axis), leaves sorted by box centre then index, children visited nearest box first (ties: left), and a
//! candidate replaces the best one only when nearer by more than `TIE` or tied and of a lower index. Same visit order + same
//! arithmetic (`llull_jsmath::hypot`) = the same leaf for every query, so native results match the TypeScript reference bit for bit.

pub mod geometry;

use llull_jsmath::hypot;

pub type Vec3 = [f64; 3];

/// Axis-aligned box.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Aabb {
    pub low: Vec3,
    pub high: Vec3,
}

/// Distance below which two candidate leaves tie (the lower index wins).
pub const TIE: f64 = 1e-15;

#[derive(Debug, Clone)]
enum Node {
    Leaf { bounds: Aabb, item: usize },
    Inner { bounds: Aabb, left: usize, right: usize },
}

impl Node {
    fn bounds(&self) -> &Aabb {
        match self {
            Node::Leaf { bounds, .. } | Node::Inner { bounds, .. } => bounds,
        }
    }
}

/// A binary tree over item boxes; item indices are the positions in the slice given to `build`.
#[derive(Debug, Clone)]
pub struct Bvh {
    nodes: Vec<Node>,
    root: usize,
}

/// Euclidean distance from `p` to the box (0 inside).
pub fn box_distance(bounds: &Aabb, p: &Vec3) -> f64 {
    let gap = |axis: usize| (bounds.low[axis] - p[axis]).max(0.0).max(p[axis] - bounds.high[axis]);
    hypot(&[gap(0), gap(1), gap(2)])
}

/// The best leaf found by `Bvh::nearest`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hit {
    pub item: usize,
    pub distance: f64,
    pub point: Vec3,
}

impl Bvh {
    /// Builds the tree; `None` for no items.
    pub fn build(items: &[Aabb]) -> Option<Bvh> {
        if items.is_empty() {
            return None;
        }
        let mut tree = Bvh { nodes: Vec::with_capacity(items.len() * 2), root: 0 };
        let indices: Vec<usize> = (0..items.len()).collect();
        tree.root = tree.split(items, &indices);
        Some(tree)
    }

    fn split(&mut self, items: &[Aabb], indices: &[usize]) -> usize {
        if indices.len() == 1 {
            let item = indices[0];
            self.nodes.push(Node::Leaf { bounds: items[item], item });
            return self.nodes.len() - 1;
        }
        let mut low = [f64::INFINITY; 3];
        let mut high = [f64::NEG_INFINITY; 3];
        for &index in indices {
            for axis in 0..3 {
                low[axis] = low[axis].min(items[index].low[axis]);
                high[axis] = high[axis].max(items[index].high[axis]);
            }
        }
        let mut axis = 0;
        for candidate in 1..3 {
            if high[candidate] - low[candidate] > high[axis] - low[axis] {
                axis = candidate;
            }
        }
        let centre = |index: usize| (items[index].low[axis] + items[index].high[axis]) / 2.0;
        let mut sorted = indices.to_vec();
        sorted.sort_by(|&a, &b| centre(a).total_cmp(&centre(b)).then(a.cmp(&b)));
        let half = sorted.len() >> 1;
        let left = self.split(items, &sorted[..half]);
        let right = self.split(items, &sorted[half..]);
        self.nodes.push(Node::Inner { bounds: Aabb { low, high }, left, right });
        self.nodes.len() - 1
    }

    /// The nearest item to `p` under `leaf` (distance and closest point of an item), with the TIE rule (lower index wins).
    /// Branch and bound: a subtree is skipped when its box is farther than the best distance + TIE.
    pub fn nearest(&self, p: &Vec3, leaf: &impl Fn(usize) -> (f64, Vec3)) -> Option<Hit> {
        let mut best: Option<Hit> = None;
        self.visit(self.root, p, leaf, &mut best);
        best
    }

    /// Every item whose box is within `radius` of `p` (box distance), in ascending item order: the candidate set of a contact search.
    pub fn overlapping(&self, p: &Vec3, radius: f64) -> Vec<usize> {
        let mut found = Vec::new();
        let mut stack = vec![self.root];
        while let Some(node) = stack.pop() {
            let current = &self.nodes[node];
            if box_distance(current.bounds(), p) > radius {
                continue;
            }
            match current {
                Node::Leaf { item, .. } => found.push(*item),
                Node::Inner { left, right, .. } => {
                    stack.push(*right);
                    stack.push(*left);
                }
            }
        }
        found.sort_unstable();
        found
    }

    fn visit(&self, node: usize, p: &Vec3, leaf: &impl Fn(usize) -> (f64, Vec3), best: &mut Option<Hit>) {
        let current = &self.nodes[node];
        if let Some(found) = best {
            if box_distance(current.bounds(), p) > found.distance + TIE {
                return;
            }
        }
        match current {
            Node::Leaf { item, .. } => {
                let (distance, point) = leaf(*item);
                let better = match best {
                    None => true,
                    Some(found) => distance < found.distance - TIE || ((distance - found.distance).abs() <= TIE && *item < found.item),
                };
                if better {
                    *best = Some(Hit { item: *item, distance, point });
                }
            }
            Node::Inner { left, right, .. } => {
                let left_distance = box_distance(self.nodes[*left].bounds(), p);
                let right_distance = box_distance(self.nodes[*right].bounds(), p);
                let order = if right_distance < left_distance { [*right, *left] } else { [*left, *right] };
                for child in order {
                    self.visit(child, p, leaf, best);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_box(x: f64) -> Aabb {
        Aabb { low: [x, 0.0, 0.0], high: [x + 1.0, 1.0, 1.0] }
    }

    #[test]
    fn finds_the_nearest_box_and_breaks_ties_by_index() {
        let boxes: Vec<Aabb> = (0..9).map(|i| unit_box(f64::from(i))).collect();
        let tree = Bvh::build(&boxes).unwrap();
        let leaf = |item: usize| (box_distance(&boxes[item], &[4.5, 0.5, 0.5]), [4.5, 0.5, 0.5]);
        assert_eq!(tree.nearest(&[4.5, 0.5, 0.5], &leaf).unwrap().item, 4);
        let shared = |item: usize| (box_distance(&boxes[item], &[5.0, 0.5, 0.5]), [5.0, 0.5, 0.5]);
        assert_eq!(tree.nearest(&[5.0, 0.5, 0.5], &shared).unwrap().item, 4, "on the face shared by 4 and 5: the lower index");
        let far = |item: usize| (box_distance(&boxes[item], &[20.0, 0.5, 0.5]), [9.0, 0.5, 0.5]);
        let hit = tree.nearest(&[20.0, 0.5, 0.5], &far).unwrap();
        assert_eq!((hit.item, hit.distance), (8, 11.0));
        assert!(Bvh::build(&[]).is_none());
    }

    #[test]
    fn lists_every_box_within_a_radius_in_index_order() {
        let boxes: Vec<Aabb> = (0..9).map(|i| unit_box(f64::from(i))).rev().collect();
        let tree = Bvh::build(&boxes).unwrap();
        // Boxes are reversed: item k spans x in [8 - k, 9 - k]. The point x = 4.5 is inside item 4; radius 1 reaches items 3, 4, 5.
        assert_eq!(tree.overlapping(&[4.5, 0.5, 0.5], 0.0), vec![4]);
        assert_eq!(tree.overlapping(&[4.5, 0.5, 0.5], 0.6), vec![3, 4, 5]);
        assert!(tree.overlapping(&[50.0, 0.5, 0.5], 1.0).is_empty());
    }
}
