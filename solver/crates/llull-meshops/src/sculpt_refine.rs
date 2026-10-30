//! The refinement before a stroke (`refine` of `sculpt.ts`): up to 8 passes that split every edge longer than `refineEdge` whose midpoint is within the radius of a
//! stamp centre. The edges of a pass are listed first (ascending faces, `u < v`), then split in that order, as in the TypeScript code.

use crate::edit::EditMesh;
use crate::geom::{dist, Vec3};
use std::collections::HashSet;

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

/// The edges of one pass as (low, high), twin of `passEdges` in `sculpt.ts`: an edge once per live face that runs it from the lower to the higher index, in face order,
/// and an edge no face runs that way (a boundary edge traversed from the higher index) once, at its first face.
fn pass_edges(edit: &EditMesh) -> Vec<(u32, u32)> {
    let key = |u: u32, v: u32| u64::from(u) << 32 | u64::from(v);
    let live = || {
        (0..edit.f_alive.len()).filter(|&f| edit.f_alive[f]).flat_map(|f| {
            let [a, b, c] = edit.corners(f as u32);
            [(a, b), (b, c), (c, a)]
        })
    };
    let mut ascending: HashSet<u64> = live().filter(|&(u, v)| u < v).map(|(u, v)| key(u, v)).collect();
    let mut edges = Vec::new();
    for (u, v) in live() {
        if u < v {
            edges.push((u, v));
        } else if u > v && ascending.insert(key(v, u)) {
            edges.push((v, u));
        }
    }
    edges
}

pub fn refine(positions: &[f64], triangles: &[u32], limit: f64, radius: f64, centres: &[Vec3], max_triangles: usize) -> Refined {
    let mut edit = EditMesh::new(positions, triangles);
    let mut splits = 0;
    for _ in 0..PASSES {
        let mut count = 0;
        let edges = pass_edges(&edit);
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
