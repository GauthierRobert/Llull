//! Second-order (C3D10) elements of a stuffed mesh (FLL-M1): one mid-edge node per edge, shared by every tetrahedron using it; the mid nodes
//! of boundary edges are projected onto the iso-surface (Newton along the field gradient) so the elements follow the curved surface, and a
//! projection that makes an element's Jacobian too small anywhere is undone. The volume is the exact integral of det J (degree-3 Keast rule).
//! @invariant a projected mid node moves at most MAX_PROJECTION of its edge length, else it stays straight
//! @invariant after `order2`, every element has det J >= MIN_JACOBIAN_RATIO x its straight det J at the 15 check points (corners, edge
//!   midpoints, Keast points); the undo loop stops when a pass reverts nothing (each pass reverts at least one node, so it ends)

use crate::eval::Evaluator;
use crate::gradient::GradientScratch;
use crate::stuffing::orient;
use crate::tet_quality::BoundaryFace;
use rayon::prelude::*;

/// C3D10 mid-edge nodes 5..10 over 0-based corners: 1-2, 2-3, 3-1, 1-4, 2-4, 3-4.
pub const TET10_EDGES: [(usize, usize); 6] = [(0, 1), (1, 2), (2, 0), (0, 3), (1, 3), (2, 3)];
/// Largest move of a projected mid node, as a fraction of its edge length (a larger jump would reach another sheet of the surface).
const MAX_PROJECTION: f64 = 0.25;
/// Smallest det J of a curved element relative to its straight-sided det J at any check point.
pub const MIN_JACOBIAN_RATIO: f64 = 0.2;
/// Named guard of one Newton projection; it stops earlier on a zero value, a vanishing step or a non-finite value.
const NEWTON_STEPS: usize = 12;
/// Keast degree-3 rule on the reference tetrahedron: barycentric points and weights (sum 1; times 1/6 for the volume).
const KEAST: [([f64; 4], f64); 5] = [
    ([0.25, 0.25, 0.25, 0.25], -0.8),
    ([0.5, 1.0 / 6.0, 1.0 / 6.0, 1.0 / 6.0], 0.45),
    ([1.0 / 6.0, 0.5, 1.0 / 6.0, 1.0 / 6.0], 0.45),
    ([1.0 / 6.0, 1.0 / 6.0, 0.5, 1.0 / 6.0], 0.45),
    ([1.0 / 6.0, 1.0 / 6.0, 1.0 / 6.0, 0.5], 0.45),
];

pub struct Order2 {
    /// Mid-edge node positions (node index = corner count + position here).
    pub mids: Vec<[f64; 3]>,
    /// Sorted unique edges (corner pairs, lo < hi), one per mid node.
    pub edges: Vec<(u32, u32)>,
    pub elements: Vec<[u32; 10]>,
    /// Mid nodes on the boundary projected onto the surface (after the undo loop).
    pub curved: usize,
    pub reverted: usize,
}

fn mid_of(edges: &[(u32, u32)], a: u32, b: u32) -> u32 {
    let key = (a.min(b), a.max(b));
    match edges.binary_search(&key) {
        Ok(found) => found as u32,
        Err(_) => unreachable!("edge {a}-{b} of an element is not in the edge list"),
    }
}

/// det J of a C3D10 element (`x`: 10 node positions) at barycentric point `l`.
pub fn det_j(x: &[[f64; 3]; 10], l: &[f64; 4]) -> f64 {
    let mut g = [[0.0f64; 3]; 4];
    for (k, gk) in g.iter_mut().enumerate() {
        for axis in 0..3 {
            gk[axis] += x[k][axis] * (4.0 * l[k] - 1.0);
        }
    }
    for (m, &(a, b)) in TET10_EDGES.iter().enumerate() {
        for axis in 0..3 {
            g[a][axis] += x[4 + m][axis] * 4.0 * l[b];
            g[b][axis] += x[4 + m][axis] * 4.0 * l[a];
        }
    }
    let j = [1, 2, 3].map(|k| [g[k][0] - g[0][0], g[k][1] - g[0][1], g[k][2] - g[0][2]]);
    j[0][0] * (j[1][1] * j[2][2] - j[1][2] * j[2][1]) - j[0][1] * (j[1][0] * j[2][2] - j[1][2] * j[2][0])
        + j[0][2] * (j[1][0] * j[2][1] - j[1][1] * j[2][0])
}

/// The 15 barycentric check points of the Jacobian.
fn check_points() -> Vec<[f64; 4]> {
    let mut points: Vec<[f64; 4]> = (0..4).map(|k| [0, 1, 2, 3].map(|i| if i == k { 1.0 } else { 0.0 })).collect();
    points.extend(TET10_EDGES.iter().map(|&(a, b)| [0, 1, 2, 3].map(|i| if i == a || i == b { 0.5 } else { 0.0 })));
    points.extend(KEAST.iter().map(|(p, _)| *p));
    points
}

/// Volume of a C3D10 element (exact: det J is cubic in the barycentric coordinates).
pub fn element_volume(x: &[[f64; 3]; 10]) -> f64 {
    KEAST.iter().map(|(l, w)| w * det_j(x, l)).sum::<f64>() / 6.0
}

/// Newton projection of `start` onto f = 0; None when it does not converge closer or moves too far.
fn project(evaluator: &Evaluator, scratch: &mut GradientScratch, start: [f64; 3], reach: f64) -> Option<[f64; 3]> {
    let (f0, _) = evaluator.value_gradient_at(scratch, start[0], start[1], start[2]);
    if !f0.is_finite() {
        return None;
    }
    let mut x = start;
    let mut f = f0;
    for _ in 0..NEWTON_STEPS {
        if f == 0.0 {
            break;
        }
        let (_, g) = evaluator.value_gradient_at(scratch, x[0], x[1], x[2]);
        let gg = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
        if !(gg > 0.0 && gg.is_finite()) {
            break;
        }
        let next = [0, 1, 2].map(|a| x[a] - f / gg * g[a]);
        let (value, _) = evaluator.value_gradient_at(scratch, next[0], next[1], next[2]);
        if !value.is_finite() || value.abs() >= f.abs() {
            break;
        }
        x = next;
        f = value;
    }
    let moved = ((x[0] - start[0]).powi(2) + (x[1] - start[1]).powi(2) + (x[2] - start[2]).powi(2)).sqrt();
    (f.abs() < f0.abs() && moved <= reach).then_some(x)
}

/// C3D10 elements of `tets`; boundary mid nodes curved onto the surface of `evaluator`.
pub fn order2(evaluator: &Evaluator, positions: &[[f64; 3]], tets: &[[u32; 4]], boundary: &[BoundaryFace]) -> Order2 {
    let mut edges: Vec<(u32, u32)> =
        tets.par_iter().flat_map_iter(|t| TET10_EDGES.iter().map(move |&(a, b)| (t[a].min(t[b]), t[a].max(t[b])))).collect();
    edges.par_sort_unstable();
    edges.dedup();
    let corners = positions.len() as u32;
    let straight: Vec<[f64; 3]> =
        edges.par_iter().map(|&(a, b)| [0, 1, 2].map(|i| 0.5 * (positions[a as usize][i] + positions[b as usize][i]))).collect();
    let mut on_boundary = vec![false; edges.len()];
    for face in boundary {
        for (a, b) in [(0, 1), (1, 2), (2, 0)] {
            on_boundary[mid_of(&edges, face.corners[a], face.corners[b]) as usize] = true;
        }
    }
    let mut mids: Vec<[f64; 3]> = edges
        .par_iter()
        .enumerate()
        .map_init(
            || GradientScratch::new(evaluator.instrs.len()),
            |scratch, (m, &(a, b))| {
                if !on_boundary[m] {
                    return straight[m];
                }
                let length = (0..3).map(|i| (positions[a as usize][i] - positions[b as usize][i]).powi(2)).sum::<f64>().sqrt();
                project(evaluator, scratch, straight[m], MAX_PROJECTION * length).unwrap_or(straight[m])
            },
        )
        .collect();
    let elements: Vec<[u32; 10]> = tets
        .par_iter()
        .map(|t| {
            let mut row = [0u32; 10];
            row[..4].copy_from_slice(t);
            for (m, &(a, b)) in TET10_EDGES.iter().enumerate() {
                row[4 + m] = corners + mid_of(&edges, t[a], t[b]);
            }
            row
        })
        .collect();
    let points = check_points();
    let node = |mids: &[[f64; 3]], v: u32| if v < corners { positions[v as usize] } else { mids[(v - corners) as usize] };
    let mut reverted = 0;
    loop {
        let undo: Vec<u32> = elements
            .par_iter()
            .filter(|row| row[4..].iter().any(|&v| mids[(v - corners) as usize] != straight[(v - corners) as usize]))
            .flat_map_iter(|row| {
                let x = row.map(|v| node(&mids, v));
                let linear = orient(&[x[0], x[1], x[2], x[3]]);
                let bad = points.iter().any(|l| det_j(&x, l).partial_cmp(&(MIN_JACOBIAN_RATIO * linear)).is_none_or(|o| o.is_lt()));
                let curved: Vec<u32> = if bad {
                    row[4..].iter().map(|&v| v - corners).filter(|&m| mids[m as usize] != straight[m as usize]).collect()
                } else {
                    Vec::new()
                };
                curved
            })
            .collect();
        if undo.is_empty() {
            break;
        }
        for m in undo {
            if mids[m as usize] != straight[m as usize] {
                mids[m as usize] = straight[m as usize];
                reverted += 1;
            }
        }
    }
    let curved = mids.iter().zip(&straight).filter(|(a, b)| a != b).count();
    Order2 { mids, edges, elements, curved, reverted }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn straight_element(c: [[f64; 3]; 4]) -> [[f64; 3]; 10] {
        let mut x = [[0.0; 3]; 10];
        x[..4].copy_from_slice(&c);
        for (m, &(a, b)) in TET10_EDGES.iter().enumerate() {
            x[4 + m] = [0, 1, 2].map(|i| 0.5 * (c[a][i] + c[b][i]));
        }
        x
    }

    #[test]
    fn a_straight_element_has_the_linear_jacobian_and_volume() {
        let c = [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 3.0, 0.0], [0.0, 0.0, 4.0]];
        let x = straight_element(c);
        for l in check_points() {
            assert!((det_j(&x, &l) - orient(&c)).abs() < 1e-12);
        }
        assert!((element_volume(&x) - 4.0).abs() < 1e-12, "2 * 3 * 4 / 6");
    }

    #[test]
    fn a_bulged_mid_node_changes_the_volume_affinely() {
        // det J is multilinear in its columns and one mid-node offset adds the same direction to all three: the volume is affine in it
        let c = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let mut x = straight_element(c);
        let base = element_volume(&x);
        x[4][1] -= 0.1;
        let bulged = element_volume(&x);
        x[4][1] -= 0.1;
        let twice = element_volume(&x);
        assert!(bulged > base);
        assert!((twice - base - 2.0 * (bulged - base)).abs() < 1e-12, "the volume is linear in one mid-node offset");
    }
}
