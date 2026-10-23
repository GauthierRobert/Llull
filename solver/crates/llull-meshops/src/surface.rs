//! Closest-point index of an indexed triangle mesh (twin of `surfaceIndex.ts` and `triangleQueries.closestPointOnTriangle`): a median-split
//! AABB tree, leaf size 6, the same split order, traversal order and tie rule, so the distances equal the TypeScript ones bit for bit.

use crate::geom::Vec3;

const LEAF: usize = 6;

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn scale(a: Vec3, s: f64) -> Vec3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Closest point of triangle `abc` to `p` (Ericson, Real-Time Collision Detection 5.1.5).
pub fn closest_point_on_triangle(p: Vec3, [a, b, c]: [Vec3; 3]) -> Vec3 {
    let ab = sub(b, a);
    let ac = sub(c, a);
    let ap = sub(p, a);
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }
    let bp = sub(p, b);
    let d3 = dot(ab, bp);
    let d4 = dot(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return add(a, scale(ab, d1 / (d1 - d3)));
    }
    let cp = sub(p, c);
    let d5 = dot(ab, cp);
    let d6 = dot(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return add(a, scale(ac, d2 / (d2 - d6)));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        return add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
    }
    let denominator = 1.0 / (va + vb + vc);
    add(a, add(scale(ab, vb * denominator), scale(ac, vc * denominator)))
}

pub struct SurfaceIndex {
    face_count: usize,
    corners: Vec<f64>,
    order: Vec<u32>,
    boxes: Vec<f64>,
    left: Vec<i64>,
    right: Vec<i64>,
    start: Vec<usize>,
    end: Vec<usize>,
}

impl SurfaceIndex {
    pub fn new(positions: &[f64], triangles: &[u32]) -> Self {
        let face_count = triangles.len() / 3;
        let mut corners = vec![0.0; face_count * 9];
        for t in 0..face_count {
            for k in 0..3 {
                let v = triangles[t * 3 + k] as usize;
                corners[t * 9 + k * 3..t * 9 + k * 3 + 3].copy_from_slice(&positions[v * 3..v * 3 + 3]);
            }
        }
        let mut index = Self {
            face_count,
            corners,
            order: (0..face_count as u32).collect(),
            boxes: Vec::new(),
            left: Vec::new(),
            right: Vec::new(),
            start: Vec::new(),
            end: Vec::new(),
        };
        if face_count > 0 {
            index.build(0, face_count);
        }
        index
    }

    fn centre(&self, t: u32, axis: usize) -> f64 {
        let o = t as usize * 9 + axis;
        (self.corners[o] + self.corners[o + 3] + self.corners[o + 6]) / 3.0
    }

    fn build(&mut self, start: usize, end: usize) -> i64 {
        let node = self.left.len();
        self.left.push(-1);
        self.right.push(-1);
        self.start.push(start);
        self.end.push(end);
        let mut bounds = [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for i in start..end {
            let o = self.order[i] as usize * 9;
            for k in 0..9 {
                let axis = k % 3;
                bounds[axis] = bounds[axis].min(self.corners[o + k]);
                bounds[axis + 3] = bounds[axis + 3].max(self.corners[o + k]);
            }
        }
        self.boxes.extend_from_slice(&bounds);
        if end - start > LEAF {
            let [ex, ey, ez] = [bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]];
            let axis = if ex >= ey && ex >= ez {
                0
            } else if ey >= ez {
                1
            } else {
                2
            };
            let mut slice: Vec<u32> = self.order[start..end].to_vec();
            slice.sort_by(|&x, &y| {
                self.centre(x, axis).partial_cmp(&self.centre(y, axis)).unwrap_or(std::cmp::Ordering::Equal).then(x.cmp(&y))
            });
            self.order[start..end].copy_from_slice(&slice);
            let mid = (start + end) >> 1;
            let l = self.build(start, mid);
            self.left[node] = l;
            let r = self.build(mid, end);
            self.right[node] = r;
        }
        node as i64
    }

    fn box_distance_sq(&self, node: usize, p: Vec3) -> f64 {
        let mut sum = 0.0;
        for (a, &x) in p.iter().enumerate() {
            let lo = self.boxes[node * 6 + a];
            let hi = self.boxes[node * 6 + a + 3];
            let d = if x < lo {
                lo - x
            } else if x > hi {
                x - hi
            } else {
                0.0
            };
            sum += d * d;
        }
        sum
    }

    /// Distance from `p` to the nearest triangle (infinity for an empty mesh).
    pub fn closest_distance(&self, p: Vec3) -> f64 {
        if self.face_count == 0 {
            return f64::INFINITY;
        }
        let mut best_sq = f64::INFINITY;
        let mut best_face: i64 = -1;
        let mut stack: Vec<usize> = vec![0];
        while let Some(node) = stack.pop() {
            if self.box_distance_sq(node, p) > best_sq {
                continue;
            }
            if self.left[node] < 0 {
                for i in self.start[node]..self.end[node] {
                    let t = self.order[i];
                    let o = t as usize * 9;
                    let c = &self.corners;
                    let hit = closest_point_on_triangle(
                        p,
                        [[c[o], c[o + 1], c[o + 2]], [c[o + 3], c[o + 4], c[o + 5]], [c[o + 6], c[o + 7], c[o + 8]]],
                    );
                    let d_sq = (hit[0] - p[0]) * (hit[0] - p[0]) + (hit[1] - p[1]) * (hit[1] - p[1]) + (hit[2] - p[2]) * (hit[2] - p[2]);
                    if d_sq < best_sq || (d_sq == best_sq && i64::from(t) < best_face) {
                        best_sq = d_sq;
                        best_face = i64::from(t);
                    }
                }
            } else {
                let l = self.left[node] as usize;
                let r = self.right[node] as usize;
                if self.box_distance_sq(l, p) <= self.box_distance_sq(r, p) {
                    stack.push(r);
                    stack.push(l);
                } else {
                    stack.push(l);
                    stack.push(r);
                }
            }
        }
        best_sq.sqrt()
    }
}
