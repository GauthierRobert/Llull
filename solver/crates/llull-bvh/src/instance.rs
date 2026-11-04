//! Instance BVH: a port of `packages/core/src/geometry/instanceBvh.ts` (plant 09 VIS-M8b, RS-6 `llull-bvh` option). Deterministic binned
//! SAH (16 bins, widest centroid axis, leaves of at most 4 boxes, identical-centroid runs halved by index) into flat arrays, node numbering
//! and expression order identical to the TypeScript build, so the tree arrays are equal bit for bit. Queries return ascending box indices
//! equal to the brute-force scan. Boxes must be finite.

const LEAF_SIZE: usize = 4;
const BIN_COUNT: usize = 16;

/// Half-space `normal . p + offset >= 0`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Plane {
    pub normal: [f64; 3],
    pub offset: f64,
}

/// Flat tree: `order` is the leaf-order permutation of the boxes; node `n` covers `order[node_start[n]..node_end[n]]`; `node_child[n]` is the
/// first child (the second is the next node), -1 for a leaf.
#[derive(Debug, Clone, PartialEq)]
pub struct InstanceBvh {
    pub count: usize,
    pub boxes: Vec<f64>,
    pub order: Vec<u32>,
    pub node_box: Vec<f64>,
    pub node_start: Vec<u32>,
    pub node_end: Vec<u32>,
    pub node_child: Vec<i32>,
}

/// Brute-force predicate of `frustum_query` for the box at `offset` of `boxes`.
pub fn box_inside_planes(boxes: &[f64], offset: usize, planes: &[Plane]) -> bool {
    planes.iter().all(|plane| {
        let n = plane.normal;
        let x = if n[0] >= 0.0 { boxes[offset + 3] } else { boxes[offset] };
        let y = if n[1] >= 0.0 { boxes[offset + 4] } else { boxes[offset + 1] };
        let z = if n[2] >= 0.0 { boxes[offset + 5] } else { boxes[offset + 2] };
        n[0] * x + n[1] * y + n[2] * z + plane.offset >= 0.0
    })
}

fn box_fully_inside_planes(boxes: &[f64], offset: usize, planes: &[Plane]) -> bool {
    planes.iter().all(|plane| {
        let n = plane.normal;
        let x = if n[0] >= 0.0 { boxes[offset] } else { boxes[offset + 3] };
        let y = if n[1] >= 0.0 { boxes[offset + 1] } else { boxes[offset + 4] };
        let z = if n[2] >= 0.0 { boxes[offset + 2] } else { boxes[offset + 5] };
        n[0] * x + n[1] * y + n[2] * z + plane.offset >= 0.0
    })
}

/// Brute-force predicate of `ray_query` (slab test).
pub fn ray_hits_box(boxes: &[f64], offset: usize, origin: &[f64; 3], direction: &[f64; 3]) -> bool {
    let mut near = 0.0_f64;
    let mut far = f64::INFINITY;
    for axis in 0..3 {
        let (low, high) = (boxes[offset + axis], boxes[offset + 3 + axis]);
        let (o, d) = (origin[axis], direction[axis]);
        if d == 0.0 {
            if o < low || o > high {
                return false;
            }
            continue;
        }
        let (t1, t2) = ((low - o) / d, (high - o) / d);
        let (lo, hi) = if t1 <= t2 { (t1, t2) } else { (t2, t1) };
        if lo > near {
            near = lo;
        }
        if hi < far {
            far = hi;
        }
        if near > far {
            return false;
        }
    }
    true
}

/// Brute-force predicate of `box_query` (closed boxes, touching counts).
pub fn box_overlaps_box(boxes: &[f64], offset: usize, min: &[f64; 3], max: &[f64; 3]) -> bool {
    boxes[offset] <= max[0]
        && boxes[offset + 3] >= min[0]
        && boxes[offset + 1] <= max[1]
        && boxes[offset + 4] >= min[1]
        && boxes[offset + 2] <= max[2]
        && boxes[offset + 5] >= min[2]
}

fn area(dx: f64, dy: f64, dz: f64) -> f64 {
    if dx < 0.0 {
        0.0
    } else {
        dx * dy + dy * dz + dz * dx
    }
}

fn bin_of(centroid: f64, low: f64, scale: f64) -> usize {
    (((centroid - low) * scale).floor()).min((BIN_COUNT - 1) as f64) as usize
}

const EMPTY: [f64; 6] = [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];

fn grow(bounds: &mut [f64; 6], other: &[f64]) {
    for a in 0..3 {
        bounds[a] = bounds[a].min(other[a]);
        bounds[3 + a] = bounds[3 + a].max(other[3 + a]);
    }
}

fn bounds_area(b: &[f64; 6]) -> f64 {
    area(b[3] - b[0], b[4] - b[1], b[5] - b[2])
}

/// Binned-SAH split of `order[start..end]` on the widest centroid axis; the split position, or None when every centroid coincides.
fn sah_split(boxes: &[f64], centroids: &[f64], order: &mut [u32], start: usize, end: usize) -> Option<usize> {
    let mut low_c = [f64::INFINITY; 3];
    let mut high_c = [f64::NEG_INFINITY; 3];
    for &id in &order[start..end] {
        for a in 0..3 {
            let c = centroids[id as usize * 3 + a];
            if c < low_c[a] {
                low_c[a] = c;
            }
            if c > high_c[a] {
                high_c[a] = c;
            }
        }
    }
    let axis = (0..3).fold(0, |best, a| if high_c[a] - low_c[a] > high_c[best] - low_c[best] { a } else { best });
    let low = low_c[axis];
    let extent = high_c[axis] - low;
    if extent.is_nan() || extent <= 0.0 {
        return None;
    }
    let scale = BIN_COUNT as f64 / extent;
    let mut bin_count = [0_u32; BIN_COUNT];
    let mut bin_box = [EMPTY; BIN_COUNT];
    for &id in &order[start..end] {
        let id = id as usize;
        let bin = bin_of(centroids[id * 3 + axis], low, scale);
        bin_count[bin] += 1;
        grow(&mut bin_box[bin], &boxes[id * 6..id * 6 + 6]);
    }
    let mut left_area = [0.0_f64; BIN_COUNT];
    let mut acc = EMPTY;
    let mut counted = 0_u32;
    for b in 0..BIN_COUNT - 1 {
        grow(&mut acc, &bin_box[b]);
        counted += bin_count[b];
        left_area[b] = if counted == 0 { 0.0 } else { bounds_area(&acc) * f64::from(counted) };
    }
    acc = EMPTY;
    let mut right_count = 0_u32;
    let mut best_cost = f64::INFINITY;
    let mut best_bin = None;
    for b in (1..BIN_COUNT).rev() {
        grow(&mut acc, &bin_box[b]);
        right_count += bin_count[b];
        let left_count = (end - start) as u32 - right_count;
        if right_count == 0 || left_count == 0 {
            continue;
        }
        let cost = left_area[b - 1] + bounds_area(&acc) * f64::from(right_count);
        if cost < best_cost {
            best_cost = cost;
            best_bin = Some(b);
        }
    }
    let best_bin = best_bin?;
    let (mut left, mut right) = (start as isize, end as isize - 1);
    while left <= right {
        let id = order[left as usize];
        if bin_of(centroids[id as usize * 3 + axis], low, scale) < best_bin {
            left += 1;
        } else {
            order[left as usize] = order[right as usize];
            order[right as usize] = id;
            right -= 1;
        }
    }
    let left = left as usize;
    (left > start && left < end).then_some(left)
}

impl InstanceBvh {
    /// Builds the tree of `boxes` (`[minX, minY, minZ, maxX, maxY, maxZ]` per box).
    pub fn build(boxes: &[f64]) -> InstanceBvh {
        let count = boxes.len() / 6;
        let mut centroids = vec![0.0_f64; count * 3];
        for i in 0..count {
            for a in 0..3 {
                centroids[i * 3 + a] = (boxes[i * 6 + a] + boxes[i * 6 + 3 + a]) * 0.5;
            }
        }
        let mut order: Vec<u32> = (0..count as u32).collect();
        let mut node_box: Vec<f64> = Vec::new();
        let mut node_start: Vec<u32> = Vec::new();
        let mut node_end: Vec<u32> = Vec::new();
        let mut node_child: Vec<i32> = Vec::new();
        if count > 0 {
            node_box.resize(6, 0.0);
            node_start.push(0);
            node_end.push(count as u32);
            node_child.push(-1);
            let mut stack = vec![0_usize];
            while let Some(node) = stack.pop() {
                let (start, end) = (node_start[node] as usize, node_end[node] as usize);
                let mut bounds = EMPTY;
                for &id in &order[start..end] {
                    grow(&mut bounds, &boxes[id as usize * 6..id as usize * 6 + 6]);
                }
                node_box[node * 6..node * 6 + 6].copy_from_slice(&bounds);
                if end - start <= LEAF_SIZE {
                    continue;
                }
                let split = sah_split(boxes, &centroids, &mut order, start, end).unwrap_or(start + ((end - start) >> 1));
                let child = node_start.len();
                node_child[node] = child as i32;
                node_box.resize((child + 2) * 6, 0.0);
                node_start.extend([start as u32, split as u32]);
                node_end.extend([split as u32, end as u32]);
                node_child.extend([-1, -1]);
                stack.push(child + 1);
                stack.push(child);
            }
        }
        InstanceBvh { count, boxes: boxes.to_vec(), order, node_box, node_start, node_end, node_child }
    }

    /// Depth-first walk: `prune(node)` 0 = skip, 1 = test the leaves, 2 = take the whole subtree.
    fn walk(&self, prune: impl Fn(usize) -> u8, leaf_hit: impl Fn(usize) -> bool) -> Vec<u32> {
        let mut found: Vec<u32> = Vec::new();
        if self.count == 0 {
            return found;
        }
        let mut stack = vec![0_usize];
        while let Some(node) = stack.pop() {
            let mode = prune(node);
            if mode == 0 {
                continue;
            }
            let range = self.node_start[node] as usize..self.node_end[node] as usize;
            if mode == 2 {
                found.extend_from_slice(&self.order[range]);
                continue;
            }
            let child = self.node_child[node];
            if child >= 0 {
                stack.push(child as usize + 1);
                stack.push(child as usize);
            } else {
                found.extend(self.order[range].iter().copied().filter(|&id| leaf_hit(id as usize)));
            }
        }
        found.sort_unstable();
        found
    }

    /// Indices of the boxes with a point inside every plane, ascending.
    pub fn frustum_query(&self, planes: &[Plane]) -> Vec<u32> {
        self.walk(
            |node| {
                if !box_inside_planes(&self.node_box, node * 6, planes) {
                    0
                } else if box_fully_inside_planes(&self.node_box, node * 6, planes) {
                    2
                } else {
                    1
                }
            },
            |id| box_inside_planes(&self.boxes, id * 6, planes),
        )
    }

    /// Indices of the boxes the ray `origin + t * direction`, `t >= 0`, touches, ascending. Non-finite or zero direction: none.
    pub fn ray_query(&self, origin: &[f64; 3], direction: &[f64; 3]) -> Vec<u32> {
        if !direction.iter().chain(origin).all(|v| v.is_finite()) || direction.iter().all(|&d| d == 0.0) {
            return Vec::new();
        }
        self.walk(
            |node| u8::from(ray_hits_box(&self.node_box, node * 6, origin, direction)),
            |id| ray_hits_box(&self.boxes, id * 6, origin, direction),
        )
    }

    /// Indices of the boxes overlapping the closed box `[min, max]`, ascending.
    pub fn box_query(&self, min: &[f64; 3], max: &[f64; 3]) -> Vec<u32> {
        self.walk(
            |node| u8::from(box_overlaps_box(&self.node_box, node * 6, min, max)),
            |id| box_overlaps_box(&self.boxes, id * 6, min, max),
        )
    }
}
