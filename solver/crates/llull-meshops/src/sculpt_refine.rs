//! The refinement before a stroke (`refine` of `sculpt.ts`): up to 8 passes that split every edge longer than `refineEdge` whose midpoint is within the radius of a
//! stamp centre. The edges of a pass are listed first (ascending faces, `u < v`), then split in that order, as in the TypeScript code.

use crate::edit::EditMesh;
use crate::geom::{dist, Vec3};

/// Passes of splitting (a split edge gives two halves that the next pass may split again).
const PASSES: usize = 8;

pub enum Refined {
    Done {
        positions: Vec<f64>,
        indices: Vec<u32>,
        splits: usize,
    },
    /// The working mesh passed the triangle limit; the number of live triangles at that moment.
    TooLarge(usize),
}

/// True when `mid` is closer than `radius` to some centre. A centre whose offset along one axis is already `radius` cannot be: `hypot` is never below its largest
/// component, so only the others need the exact distance.
fn near_a_centre(mid: Vec3, centres: &[Vec3], radius: f64) -> bool {
    centres.iter().any(|c| {
        let offset = [mid[0] - c[0], mid[1] - c[1], mid[2] - c[2]];
        offset.iter().all(|d| d.abs() < radius) && dist(mid, *c) < radius
    })
}

pub fn refine(positions: &[f64], triangles: &[u32], limit: f64, radius: f64, centres: &[Vec3], max_triangles: usize) -> Refined {
    let mut edit = EditMesh::new(positions, triangles);
    let mut splits = 0;
    for _ in 0..PASSES {
        let mut count = 0;
        let mut edges: Vec<(u32, u32)> = Vec::new();
        for f in 0..edit.f_alive.len() {
            if !edit.f_alive[f] {
                continue;
            }
            let [a, b, c] = edit.corners(f as u32);
            edges.extend([(a, b), (b, c), (c, a)].into_iter().filter(|&(u, v)| u < v));
        }
        for (u, v) in edges {
            if edit.live_faces > max_triangles {
                return Refined::TooLarge(edit.live_faces);
            }
            if !edit.has_edge(u, v) {
                continue;
            }
            let (pu, pv) = (edit.p(u), edit.p(v));
            if dist(pu, pv) <= limit {
                continue;
            }
            let mid = [(pu[0] + pv[0]) / 2.0, (pu[1] + pv[1]) / 2.0, (pu[2] + pv[2]) / 2.0];
            if !near_a_centre(mid, centres, radius) {
                continue;
            }
            edit.split(u, v, mid);
            count += 1;
        }
        splits += count;
        if count == 0 {
            break;
        }
    }
    let (positions, indices) = edit.to_mesh();
    Refined::Done { positions, indices, splits }
}
