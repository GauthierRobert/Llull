//! Signed distance to a closed triangle mesh: twin of `packages/core/src/geometry/field/meshSdf.ts` (unsigned distance by a branch-and-bound
//! walk of the deterministic mesh tree, sign by the generalised winding number with dipole far nodes). Same traversal and arithmetic.

use crate::jsnum::{hypot3, jmax};
use llull_geomq::tree::MeshTree;
use llull_geomq::triangle::closest_point_on_triangle;
use llull_jsmath::atan2;

struct Dipole {
    n: [f64; 3],
    c: [f64; 3],
    radius: f64,
}

pub struct MeshSdf {
    tree: MeshTree,
    dipoles: Vec<Dipole>,
}

struct Total {
    n: [f64; 3],
    c: [f64; 3],
    area: f64,
}

fn accumulate(tree: &MeshTree, node: usize, out: &mut [Option<Dipole>]) -> Total {
    let mut total = Total { n: [0.0; 3], c: [0.0; 3], area: 0.0 };
    if let Some((left, right)) = tree.children(node) {
        for child in [left, right] {
            let part = accumulate(tree, child, out);
            for axis in 0..3 {
                total.n[axis] += part.n[axis];
                total.c[axis] += part.c[axis];
            }
            total.area += part.area;
        }
    } else {
        for &t in tree.leaf_triangles(node) {
            let corners = tree.triangle_corners(t);
            let g = |i: usize| corners[i];
            let (ux, uy, uz, vx, vy, vz) = (g(3) - g(0), g(4) - g(1), g(5) - g(2), g(6) - g(0), g(7) - g(1), g(8) - g(2));
            let (nx, ny, nz) = ((uy * vz - uz * vy) / 2.0, (uz * vx - ux * vz) / 2.0, (ux * vy - uy * vx) / 2.0);
            let area = hypot3(nx, ny, nz);
            total.n[0] += nx;
            total.n[1] += ny;
            total.n[2] += nz;
            total.c[0] += (area * (g(0) + g(3) + g(6))) / 3.0;
            total.c[1] += (area * (g(1) + g(4) + g(7))) / 3.0;
            total.c[2] += (area * (g(2) + g(5) + g(8))) / 3.0;
            total.area += area;
        }
    }
    let b = |i: usize| tree.node_bounds(node)[i];
    let inv = if total.area > 0.0 { 1.0 / total.area } else { 0.0 };
    out[node] = Some(Dipole {
        n: total.n,
        c: [total.c[0] * inv, total.c[1] * inv, total.c[2] * inv],
        radius: hypot3(b(3) - b(0), b(4) - b(1), b(5) - b(2)) / 2.0,
    });
    total
}

impl MeshSdf {
    /// Evaluator over a triangle soup (nine numbers per triangle); an empty mesh is +Infinity everywhere.
    pub fn new(corners: Vec<f64>) -> MeshSdf {
        let tree = MeshTree::build(corners);
        let mut slots: Vec<Option<Dipole>> = (0..tree.node_count()).map(|_| None).collect();
        if !slots.is_empty() {
            accumulate(&tree, 0, &mut slots);
        }
        let dipoles = slots.into_iter().map(|d| d.unwrap_or(Dipole { n: [0.0; 3], c: [0.0; 3], radius: 0.0 })).collect();
        MeshSdf { tree, dipoles }
    }

    fn unsigned(&self, x: f64, y: f64, z: f64) -> f64 {
        let tree = &self.tree;
        let mut best = f64::INFINITY;
        let mut stack = Vec::with_capacity(64);
        stack.push(0usize);
        while let Some(node) = stack.pop() {
            let b = |i: usize| tree.node_bounds(node)[i];
            let gap = hypot3(jmax(jmax(b(0) - x, 0.0), x - b(3)), jmax(jmax(b(1) - y, 0.0), y - b(4)), jmax(jmax(b(2) - z, 0.0), z - b(5)));
            if gap >= best {
                continue;
            }
            if let Some((left, right)) = tree.children(node) {
                stack.push(right);
                stack.push(left);
                continue;
            }
            for &t in tree.leaf_triangles(node) {
                let corners = tree.triangle_corners(t);
                let corner = |k: usize| {
                    let base = k * 3;
                    [corners[base], corners[base + 1], corners[base + 2]]
                };
                let q = closest_point_on_triangle(&[x, y, z], &[corner(0), corner(1), corner(2)]);
                let d = hypot3(q[0] - x, q[1] - y, q[2] - z);
                if d < best {
                    best = d;
                }
            }
        }
        best
    }

    fn winding(&self, x: f64, y: f64, z: f64) -> f64 {
        let tree = &self.tree;
        let mut total = 0.0;
        let mut stack = Vec::with_capacity(64);
        stack.push(0usize);
        while let Some(node) = stack.pop() {
            let d = &self.dipoles[node];
            let (rx, ry, rz) = (d.c[0] - x, d.c[1] - y, d.c[2] - z);
            let distance = hypot3(rx, ry, rz);
            if distance > 2.0 * d.radius && distance > 0.0 {
                total += (d.n[0] * rx + d.n[1] * ry + d.n[2] * rz) / (distance * distance * distance);
                continue;
            }
            if let Some((left, right)) = tree.children(node) {
                stack.push(right);
                stack.push(left);
                continue;
            }
            for &t in tree.leaf_triangles(node) {
                let corners = tree.triangle_corners(t);
                let g = |k: usize, axis: usize| corners[k * 3 + axis];
                let (ax, ay, az) = (g(0, 0) - x, g(0, 1) - y, g(0, 2) - z);
                let (bx, by, bz) = (g(1, 0) - x, g(1, 1) - y, g(1, 2) - z);
                let (cx, cy, cz) = (g(2, 0) - x, g(2, 1) - y, g(2, 2) - z);
                let (la, lb, lc) = (hypot3(ax, ay, az), hypot3(bx, by, bz), hypot3(cx, cy, cz));
                let numerator = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
                let denominator = la * lb * lc
                    + (ax * bx + ay * by + az * bz) * lc
                    + (ax * cx + ay * cy + az * cz) * lb
                    + (bx * cx + by * cy + bz * cz) * la;
                total += 2.0 * atan2(numerator, denominator);
            }
        }
        total / (4.0 * std::f64::consts::PI)
    }

    /// Signed distance at a point (negative inside).
    pub fn distance(&self, x: f64, y: f64, z: f64) -> f64 {
        if self.tree.triangle_count() == 0 {
            return f64::INFINITY;
        }
        let d = self.unsigned(x, y, z);
        if self.winding(x, y, z) > 0.5 {
            -d
        } else {
            d
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unit cube [0,1]^3 as 12 outward triangles.
    fn cube() -> Vec<f64> {
        let v = |i: usize| [(i & 1) as f64, ((i >> 1) & 1) as f64, ((i >> 2) & 1) as f64];
        let faces: [[usize; 3]; 12] = [
            [0, 2, 1],
            [1, 2, 3],
            [4, 5, 6],
            [5, 7, 6],
            [0, 1, 4],
            [1, 5, 4],
            [2, 6, 3],
            [3, 6, 7],
            [0, 4, 2],
            [2, 4, 6],
            [1, 3, 5],
            [3, 7, 5],
        ];
        faces.iter().flat_map(|f| f.iter().flat_map(|&i| v(i))).collect()
    }

    #[test]
    fn signs_and_distances_of_a_unit_cube() {
        let sdf = MeshSdf::new(cube());
        assert!((sdf.distance(0.5, 0.5, 0.5) + 0.5).abs() < 1e-12);
        assert!((sdf.distance(2.0, 0.5, 0.5) - 1.0).abs() < 1e-12);
        assert!((sdf.distance(-1.0, -1.0, 0.5) - 2.0_f64.sqrt()).abs() < 1e-12);
        assert!((sdf.distance(0.9, 0.5, 0.5) + 0.1).abs() < 1e-12);
    }

    #[test]
    fn many_triangles_exercise_the_tree_and_the_dipole_far_field() {
        let mut soup = Vec::new();
        for i in 0..40 {
            let shift = f64::from(i) * 3.0;
            for t in cube().chunks_exact(9) {
                soup.extend([t[0] + shift, t[1], t[2], t[3] + shift, t[4], t[5], t[6] + shift, t[7], t[8]]);
            }
        }
        let sdf = MeshSdf::new(soup);
        assert!((sdf.distance(60.5, 0.5, 0.5) + 0.5).abs() < 1e-9, "inside the 21st cube");
        assert!((sdf.distance(61.5, 0.5, 0.5) - 0.5).abs() < 1e-9, "outside, between two cubes");
        assert!(sdf.distance(500.0, 0.0, 0.0) > 300.0);
    }

    #[test]
    fn an_empty_mesh_is_infinitely_far() {
        assert_eq!(MeshSdf::new(Vec::new()).distance(0.0, 0.0, 0.0), f64::INFINITY);
    }
}
