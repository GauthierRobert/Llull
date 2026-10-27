//! Winding and triangulation of the quads `quad_remesh` returns (twins of `outwardQuads` and `triangulateQuads` in
//! `packages/core/src/geometry/mesh/quadCage.ts`, same operation order, so the deviation measured here is the one the host would measure on the
//! quads it commits). The job writes the raw QuadriFlow quads; only the measurement uses the outward-wound triangles.

use crate::geom::{length, Vec3};

fn at(positions: &[f64], index: u32) -> Vec3 {
    let i = index as usize * 3;
    [positions[i], positions[i + 1], positions[i + 2]]
}

fn find(parent: &mut [usize], v: usize) -> usize {
    let mut root = v;
    while parent[root] != root {
        root = parent[root];
    }
    let mut w = v;
    while parent[w] != root {
        let next = parent[w];
        parent[w] = root;
        w = next;
    }
    root
}

/// Component (shell) of every quad, numbered in order of first appearance, and the number of shells.
fn shells(quads: &[u32], vertex_count: usize) -> (Vec<usize>, usize) {
    let mut parent: Vec<usize> = (0..vertex_count).collect();
    for q in quads.chunks_exact(4) {
        let root = find(&mut parent, q[0] as usize);
        for &v in &q[1..] {
            let other = find(&mut parent, v as usize);
            parent[other] = root;
        }
    }
    let mut ids = std::collections::HashMap::new();
    let shell = quads
        .chunks_exact(4)
        .map(|q| {
            let root = find(&mut parent, q[0] as usize);
            let next = ids.len();
            *ids.entry(root).or_insert(next)
        })
        .collect();
    (shell, ids.len())
}

/// The quads wound so that every connected shell encloses a positive volume (a shell that is inside out is reversed on its own).
pub fn outward_quads(positions: &[f64], quads: &[u32]) -> Vec<u32> {
    let (shell, count) = shells(quads, positions.len() / 3);
    let mut volume = vec![0.0f64; count];
    for (f, q) in quads.chunks_exact(4).enumerate() {
        for [i, j, k] in [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] {
            let (p, qq, r) = (at(positions, i), at(positions, j), at(positions, k));
            volume[shell[f]] +=
                (p[0] * (qq[1] * r[2] - qq[2] * r[1]) - p[1] * (qq[0] * r[2] - qq[2] * r[0]) + p[2] * (qq[0] * r[1] - qq[1] * r[0])) / 6.0;
        }
    }
    let mut out = Vec::with_capacity(quads.len());
    for (f, q) in quads.chunks_exact(4).enumerate() {
        if volume[shell[f]] >= 0.0 {
            out.extend([q[0], q[1], q[2], q[3]]);
        } else {
            out.extend([q[0], q[3], q[2], q[1]]);
        }
    }
    out
}

/// Triangles (three indices each) of the quads, every quad split along its shorter diagonal.
pub fn triangulate_quads(positions: &[f64], quads: &[u32]) -> Vec<u32> {
    let distance = |i: u32, j: u32| {
        let (p, q) = (at(positions, i), at(positions, j));
        length([p[0] - q[0], p[1] - q[1], p[2] - q[2]])
    };
    let mut triangles = Vec::with_capacity(quads.len() / 4 * 6);
    for q in quads.chunks_exact(4) {
        let [a, b, c, d] = [q[0], q[1], q[2], q[3]];
        if distance(a, c) <= distance(b, d) {
            triangles.extend([a, b, c, a, c, d]);
        } else {
            triangles.extend([a, b, d, b, c, d]);
        }
    }
    triangles
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 8 corners of a cube and its 6 quads, wound outward.
    fn cube() -> (Vec<f64>, Vec<u32>) {
        let corners = (0..8u32).flat_map(|i| [(i & 1) as f64, ((i >> 1) & 1) as f64, ((i >> 2) & 1) as f64]).collect();
        (corners, vec![0, 2, 3, 1, 4, 5, 7, 6, 0, 1, 5, 4, 2, 6, 7, 3, 0, 4, 6, 2, 1, 3, 7, 5])
    }

    #[test]
    fn an_outward_cube_keeps_its_winding_and_an_inside_out_one_is_reversed() {
        let (positions, quads) = cube();
        assert_eq!(outward_quads(&positions, &quads), quads);
        let flipped: Vec<u32> = quads.chunks_exact(4).flat_map(|q| [q[0], q[3], q[2], q[1]]).collect();
        assert_eq!(outward_quads(&positions, &flipped), quads);
    }

    #[test]
    fn each_shell_is_oriented_on_its_own() {
        let (mut positions, quads) = cube();
        let second: Vec<f64> = positions.chunks_exact(3).flat_map(|p| [p[0] + 5.0, p[1], p[2]]).collect();
        positions.extend(second);
        let mut both = quads.clone();
        both.extend(quads.chunks_exact(4).flat_map(|q| [q[0] + 8, q[3] + 8, q[2] + 8, q[1] + 8]));
        let mut expected = quads.clone();
        expected.extend(quads.iter().map(|v| v + 8));
        assert_eq!(outward_quads(&positions, &both), expected);
    }

    #[test]
    fn a_quad_is_split_along_its_shorter_diagonal() {
        // a rhombus: the diagonal 0-2 is 4 long, the diagonal 1-3 is 2 long
        let positions = [0.0, 0.0, 0.0, 2.0, 1.0, 0.0, 4.0, 0.0, 0.0, 2.0, -1.0, 0.0];
        assert_eq!(triangulate_quads(&positions, &[0, 1, 2, 3]), vec![0, 1, 3, 1, 2, 3]);
        // a square: the tie goes to the first diagonal, as in the TypeScript twin
        let square = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
        assert_eq!(triangulate_quads(&square, &[0, 1, 2, 3]), vec![0, 1, 2, 0, 2, 3]);
    }
}
