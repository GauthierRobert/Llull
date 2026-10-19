//! Integer AABB tree over the inflated obstacle boxes. The answer of [`ObstacleTree::blocks`] is exactly the linear scan of
//! `segmentBlocked` in `autoRoute/lattice.ts` (open-box test on integers); the tree only skips boxes that cannot overlap.

use crate::problem::{Int3, ObstacleBox};

/// True when the axis-aligned segment a-b enters the open box (strict on fixed axes, open-interval overlap on the moving one).
pub fn segment_blocked(a: &Int3, b: &Int3, min: &Int3, max: &Int3) -> bool {
    (0..3).all(|d| {
        let (lo, hi) = (a[d].min(b[d]), a[d].max(b[d]));
        lo < max[d] && hi > min[d]
    })
}

struct Node {
    min: Int3,
    max: Int3,
    /// Leaf: `start..start + count` in `items`; inner: children at `left`, `left + 1`.
    start: usize,
    count: usize,
    left: usize,
}

pub struct ObstacleTree {
    boxes: Vec<(Int3, Int3)>,
    items: Vec<usize>,
    nodes: Vec<Node>,
}

const LEAF_SIZE: usize = 4;

impl ObstacleTree {
    pub fn build(obstacles: &[ObstacleBox]) -> ObstacleTree {
        let boxes: Vec<(Int3, Int3)> = obstacles.iter().map(|o| (o.min, o.max)).collect();
        let mut tree = ObstacleTree { items: (0..boxes.len()).collect(), boxes, nodes: Vec::new() };
        if !tree.boxes.is_empty() {
            tree.nodes.push(Node { min: [0; 3], max: [0; 3], start: 0, count: 0, left: 0 });
            tree.split(0, 0, tree.items.len());
        }
        tree
    }

    fn split(&mut self, node: usize, start: usize, end: usize) {
        let mut min = [i64::MAX; 3];
        let mut max = [i64::MIN; 3];
        for &item in &self.items[start..end] {
            let (lo, hi) = self.boxes[item];
            for d in 0..3 {
                min[d] = min[d].min(lo[d]);
                max[d] = max[d].max(hi[d]);
            }
        }
        if end - start <= LEAF_SIZE {
            self.nodes[node] = Node { min, max, start, count: end - start, left: 0 };
            return;
        }
        let axis = (0..3).max_by_key(|&d| (max[d] - min[d], std::cmp::Reverse(d))).unwrap_or(0);
        let boxes = &self.boxes;
        self.items[start..end].sort_by_key(|&item| (boxes[item].0[axis] + boxes[item].1[axis], item));
        let mid = start + (end - start) / 2;
        let left = self.nodes.len();
        self.nodes.push(Node { min: [0; 3], max: [0; 3], start: 0, count: 0, left: 0 });
        self.nodes.push(Node { min: [0; 3], max: [0; 3], start: 0, count: 0, left: 0 });
        self.nodes[node] = Node { min, max, start: 0, count: 0, left };
        self.split(left, start, mid);
        self.split(left + 1, mid, end);
    }

    /// True when the segment a-b enters any obstacle.
    pub fn blocks(&self, a: &Int3, b: &Int3) -> bool {
        if self.nodes.is_empty() {
            return false;
        }
        let mut stack = vec![0usize];
        while let Some(index) = stack.pop() {
            let node = &self.nodes[index];
            // Closed-box reject: a box that does not even touch the segment's bounding box cannot be entered.
            if (0..3).any(|d| a[d].max(b[d]) < node.min[d] || a[d].min(b[d]) > node.max[d]) {
                continue;
            }
            if node.count > 0 {
                let hit = self.items[node.start..node.start + node.count].iter().any(|&item| {
                    let (min, max) = &self.boxes[item];
                    segment_blocked(a, b, min, max)
                });
                if hit {
                    return true;
                }
            } else {
                stack.push(node.left);
                stack.push(node.left + 1);
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obstacle(min: Int3, max: Int3) -> ObstacleBox {
        ObstacleBox { id: String::new(), min, max }
    }

    #[test]
    fn touching_a_face_is_clear_and_entering_is_blocked() {
        let (min, max) = ([0, 0, 0], [10, 10, 10]);
        assert!(!segment_blocked(&[-5, 10, 5], &[20, 10, 5], &min, &max), "along the y = max face");
        assert!(segment_blocked(&[-5, 5, 5], &[1, 5, 5], &min, &max));
        assert!(!segment_blocked(&[-5, 5, 5], &[0, 5, 5], &min, &max), "ends on the face");
        assert!(segment_blocked(&[5, 5, 5], &[5, 5, 5], &min, &max), "a point inside");
    }

    #[test]
    fn the_tree_answers_like_a_linear_scan() {
        let mut boxes = Vec::new();
        let mut seed: u64 = 12345;
        let mut next = |range: i64| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as i64) % range
        };
        for _ in 0..200 {
            let min = [next(1000), next(1000), next(1000)];
            boxes.push(obstacle(min, [min[0] + 1 + next(80), min[1] + 1 + next(80), min[2] + 1 + next(80)]));
        }
        let tree = ObstacleTree::build(&boxes);
        for _ in 0..2000 {
            let a = [next(1100), next(1100), next(1100)];
            let axis = next(3) as usize;
            let mut b = a;
            b[axis] += next(200) - 100;
            let linear = boxes.iter().any(|o| segment_blocked(&a, &b, &o.min, &o.max));
            assert_eq!(tree.blocks(&a, &b), linear, "segment {a:?} -> {b:?}");
        }
        assert!(!ObstacleTree::build(&[]).blocks(&[0, 0, 0], &[5, 0, 0]));
    }
}
