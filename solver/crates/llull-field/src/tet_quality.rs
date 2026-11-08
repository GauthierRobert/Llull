//! Validity and quality of a linear tetrahedral mesh (FLL-M1): dihedral angles, the boundary faces with their CalculiX labels, and interior
//! faces whose two tetrahedra lie on the same side (folded) or that more than two tetrahedra share (non-manifold).
//! @invariant faces are matched by sorting (sorted corner triple, tetrahedron, face): a total order, so the result is thread-count independent

use crate::stuffing::orient;
use rayon::prelude::*;

/// CalculiX tet face labels over 0-based corners: 1 = 1-2-3, 2 = 1-4-2, 3 = 2-4-3, 4 = 3-4-1 (normals point inward on a positive tetrahedron).
pub const CCX_FACES: [(i32, [usize; 3]); 4] = [(1, [0, 1, 2]), (2, [0, 3, 1]), (3, [1, 3, 2]), (4, [2, 3, 0])];
/// Tetrahedra counted per dihedral bound (degrees) in the report.
const COUNT_BELOW_DEG: [f64; 3] = [5.0, 10.0, 15.0];

/// A face of exactly one tetrahedron; `corners` in CalculiX label order (outward normal after reversing them).
#[derive(Clone, Copy, Debug)]
pub struct BoundaryFace {
    pub tet: u32,
    pub label: i32,
    pub corners: [u32; 3],
}

#[derive(Debug, Clone)]
pub struct Quality {
    pub min_dihedral_deg: f64,
    pub max_dihedral_deg: f64,
    /// Tetrahedra whose smallest dihedral angle is below each of COUNT_BELOW_DEG.
    pub below: [u64; 3],
    pub folded: u64,
    pub non_manifold: u64,
    pub degenerate: u64,
}

impl Quality {
    pub fn bounds() -> [f64; 3] {
        COUNT_BELOW_DEG
    }
}

fn sub(a: &[f64; 3], b: &[f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn cross(a: &[f64; 3], b: &[f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// The six dihedral angles of a tetrahedron (radians): at edge (i, j), the angle between the faces through k and l.
pub fn dihedrals(p: &[[f64; 3]; 4]) -> [f64; 6] {
    const EDGES: [(usize, usize, usize, usize); 6] = [(0, 1, 2, 3), (0, 2, 1, 3), (0, 3, 1, 2), (1, 2, 0, 3), (1, 3, 0, 2), (2, 3, 0, 1)];
    EDGES.map(|(i, j, k, l)| {
        let e = sub(&p[j], &p[i]);
        let ee = dot(&e, &e);
        let perpendicular = |q: &[f64; 3]| {
            let v = sub(q, &p[i]);
            let s = if ee > 0.0 { dot(&v, &e) / ee } else { 0.0 };
            [v[0] - s * e[0], v[1] - s * e[1], v[2] - s * e[2]]
        };
        let (u, w) = (perpendicular(&p[k]), perpendicular(&p[l]));
        let c = cross(&u, &w);
        dot(&c, &c).sqrt().atan2(dot(&u, &w))
    })
}

/// Quality figures and the boundary faces of `tets` over `positions`.
pub fn analyse(positions: &[[f64; 3]], tets: &[[u32; 4]]) -> (Quality, Vec<BoundaryFace>) {
    let corners = |t: &[u32; 4]| t.map(|v| positions[v as usize]);
    let bounds = COUNT_BELOW_DEG.map(f64::to_radians);
    let (min, max, below, degenerate) = tets
        .par_iter()
        .map(|t| {
            let p = corners(t);
            let angles = dihedrals(&p);
            let lo = angles.iter().copied().fold(f64::INFINITY, f64::min);
            let hi = angles.iter().copied().fold(0.0, f64::max);
            let below = bounds.map(|b| u64::from(lo < b));
            (lo, hi, below, u64::from(orient(&p) <= 0.0))
        })
        .reduce(
            || (f64::INFINITY, 0.0, [0u64; 3], 0u64),
            |a, b| (a.0.min(b.0), a.1.max(b.1), [a.2[0] + b.2[0], a.2[1] + b.2[1], a.2[2] + b.2[2]], a.3 + b.3),
        );
    let mut faces: Vec<([u32; 3], u32, u8)> = tets
        .par_iter()
        .enumerate()
        .flat_map_iter(|(t, tet)| {
            CCX_FACES.iter().enumerate().map(move |(f, (_, c))| {
                let mut key = c.map(|i| tet[i]);
                key.sort_unstable();
                (key, t as u32, f as u8)
            })
        })
        .collect();
    faces.par_sort_unstable();
    let (mut boundary, mut folded, mut non_manifold) = (Vec::new(), 0u64, 0u64);
    let opposite = |t: u32, f: u8| {
        let used = CCX_FACES[f as usize].1;
        let tet = tets[t as usize];
        (0..4).find(|i| !used.contains(i)).map_or(tet[0], |i| tet[i])
    };
    let mut start = 0;
    while start < faces.len() {
        let mut end = start + 1;
        while end < faces.len() && faces[end].0 == faces[start].0 {
            end += 1;
        }
        let (key, t, f) = faces[start];
        match end - start {
            1 => {
                let (label, c) = CCX_FACES[f as usize];
                let tet = tets[t as usize];
                boundary.push(BoundaryFace { tet: t, label, corners: c.map(|i| tet[i]) });
            }
            2 => {
                let p = key.map(|v| positions[v as usize]);
                let side = |o: u32| orient(&[p[0], p[1], p[2], positions[o as usize]]);
                let (second_t, second_f) = (faces[start + 1].1, faces[start + 1].2);
                if side(opposite(t, f)) * side(opposite(second_t, second_f)) >= 0.0 {
                    folded += 1;
                }
            }
            _ => non_manifold += 1,
        }
        start = end;
    }
    let quality = Quality {
        min_dihedral_deg: if tets.is_empty() { 0.0 } else { min.to_degrees() },
        max_dihedral_deg: max.to_degrees(),
        below,
        folded,
        non_manifold,
        degenerate,
    };
    (quality, boundary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_regular_tetrahedron_has_its_dihedral_everywhere_and_four_boundary_faces() {
        let s = 1.0 / 2f64.sqrt();
        let p = [[1.0, 0.0, -s], [-1.0, 0.0, -s], [0.0, 1.0, s], [0.0, -1.0, s]];
        let positions = p.to_vec();
        let tet = if orient(&p) > 0.0 { [0, 1, 2, 3] } else { [0, 2, 1, 3] };
        let (q, boundary) = analyse(&positions, &[tet]);
        assert!((q.min_dihedral_deg - 70.528_779_365_509_3).abs() < 1e-9, "{}", q.min_dihedral_deg);
        assert!((q.max_dihedral_deg - 70.528_779_365_509_3).abs() < 1e-9);
        assert_eq!(boundary.len(), 4);
        assert_eq!((q.folded, q.non_manifold, q.degenerate), (0, 0, 0));
        let mut labels: Vec<i32> = boundary.iter().map(|f| f.label).collect();
        labels.sort_unstable();
        assert_eq!(labels, [1, 2, 3, 4]);
    }

    #[test]
    fn two_tetrahedra_on_one_side_of_their_face_are_folded() {
        let positions = vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.2, 0.2, 1.0], [0.3, 0.3, 2.0], [0.2, 0.2, -1.0]];
        let (q, boundary) = analyse(&positions, &[[0, 1, 2, 3], [0, 2, 1, 4]]);
        assert_eq!(q.folded, 1, "apexes 3 and 4 are both above face 0-1-2");
        assert_eq!(boundary.len(), 6);
        let (good, _) = analyse(&positions, &[[0, 1, 2, 3], [0, 2, 1, 5]]);
        assert_eq!(good.folded, 0);
        let (flat, _) = analyse(&[[0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 1.0, 0.0]], &[[0, 1, 2, 3]]);
        assert_eq!(flat.degenerate, 1);
        assert!(flat.min_dihedral_deg < 1e-6);
        let (three, _) = analyse(&positions, &[[0, 1, 2, 3], [0, 2, 1, 5], [0, 1, 2, 4]]);
        assert_eq!(three.non_manifold, 1);
    }
}
