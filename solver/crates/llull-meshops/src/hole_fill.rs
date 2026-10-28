//! Hole filling after Liepa (twin of `fillHoles` in `holeFill.ts`, SGP 2003): boundary loop, dynamic-programming triangulation, centroid refinement, membrane /
//! thin-plate fairing of the inserted vertices. Existing vertices and faces are never changed; patch faces are appended. The loops are those of the topology of the
//! mesh as given (the TypeScript engine does not weld first), numbered by `build_topology`.

use crate::edit::EditMesh;
use crate::geom::{dist, length, normal_of, Vec3};
use crate::hole_fair::{fair_vertices, Fairing};
use crate::hole_refine::refine_patch;
use crate::hole_triangulate::{triangulate_loop, Method};
use crate::topology::build_topology;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};

/// Which loops to fill: all, the listed loop numbers, or for each point the loop with the closest vertex.
pub enum Select {
    All,
    Loops(Vec<u64>),
    Near(Vec<Vec3>),
}

pub struct FillOptions<'a> {
    pub select: &'a Select,
    /// Loops with more edges than this are skipped (a number, as in the command: it may be fractional).
    pub max_boundary_edges: f64,
    pub fairing: Fairing,
    pub refine: bool,
    /// Liepa's density factor.
    pub alpha: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilledHole {
    #[serde(rename = "loop")]
    pub loop_index: usize,
    pub edges: usize,
    pub triangles: usize,
    pub added_vertices: usize,
    pub area: f64,
    pub triangulation: &'static str,
    pub fairing: Fairing,
}

#[derive(Debug, Serialize)]
pub struct SkippedHole {
    #[serde(rename = "loop")]
    pub loop_index: usize,
    pub edges: usize,
    pub code: &'static str,
}

/// A selection that names no loop.
#[derive(Debug, PartialEq, Eq)]
pub enum NotFound {
    /// Loop number `index` of a mesh with `loops` loops.
    Loop { index: u64, loops: usize },
    /// The point at this position of the list has no loop to be near to (the mesh has none).
    Near(usize),
}

pub struct FillResult {
    pub positions: Vec<f64>,
    pub triangles: Vec<u32>,
    pub total_loops: usize,
    pub filled: Vec<FilledHole>,
    pub skipped: Vec<SkippedHole>,
    pub not_found: Option<NotFound>,
    /// True when the selection was explicit (numbers or points) rather than all loops.
    pub explicit: bool,
}

fn select_loops(select: &Select, loops: &[Vec<u32>], mesh: &EditMesh) -> Result<Vec<usize>, NotFound> {
    match select {
        Select::All => Ok((0..loops.len()).collect()),
        Select::Loops(numbers) => {
            if let Some(&index) = numbers.iter().find(|&&i| i >= loops.len() as u64) {
                return Err(NotFound::Loop { index, loops: loops.len() });
            }
            Ok(numbers.iter().map(|&i| i as usize).collect::<BTreeSet<_>>().into_iter().collect())
        }
        Select::Near(points) => {
            let mut chosen = BTreeSet::new();
            for (at, &point) in points.iter().enumerate() {
                let mut best: Option<usize> = None;
                let mut best_distance = f64::INFINITY;
                for (index, vertices) in loops.iter().enumerate() {
                    for &v in vertices {
                        let d = dist(mesh.p(v), point);
                        if d < best_distance {
                            best_distance = d;
                            best = Some(index);
                        }
                    }
                }
                chosen.insert(best.ok_or(NotFound::Near(at))?);
            }
            Ok(chosen.into_iter().collect())
        }
    }
}

fn mean_edge(mesh: &EditMesh, v: u32, ring: &mut Vec<u32>) -> f64 {
    mesh.ring_into(v, ring);
    let p = mesh.p(v);
    let total = ring.iter().fold(0.0, |sum, &w| sum + dist(p, mesh.p(w)));
    if ring.is_empty() {
        0.0
    } else {
        total / ring.len() as f64
    }
}

/// Fill the selected boundary loops of `positions` / `triangles`; `tick` receives the share of the loops done.
pub fn fill_holes(positions: &[f64], triangles: &[u32], options: &FillOptions, tick: &mut dyn FnMut(f64)) -> FillResult {
    let mut mesh = EditMesh::new(positions, triangles);
    let topology = build_topology(positions.len() / 3, triangles);
    let explicit = !matches!(options.select, Select::All);
    let mut filled = Vec::new();
    let mut skipped = Vec::new();
    let mut not_found = None;
    match select_loops(options.select, &topology.loops, &mesh) {
        Err(error) => not_found = Some(error),
        Ok(list) => {
            let mut ring = Vec::new();
            for (done, &index) in list.iter().enumerate() {
                tick(done as f64 / list.len() as f64);
                let vertices = &topology.loops[index];
                let edges = vertices.len();
                let distinct = vertices.iter().collect::<HashSet<_>>().len();
                if distinct != edges || edges < 3 {
                    skipped.push(SkippedHole { loop_index: index, edges, code: "MESH_HOLE_NON_SIMPLE" });
                    continue;
                }
                if edges as f64 > options.max_boundary_edges {
                    skipped.push(SkippedHole { loop_index: index, edges, code: "MESH_HOLE_TOO_LARGE" });
                    continue;
                }
                let mut sigma: HashMap<u32, f64> = vertices.iter().map(|&v| (v, mean_edge(&mesh, v, &mut ring))).collect();
                let Some(patch) = triangulate_loop(vertices, &mesh) else {
                    skipped.push(SkippedHole { loop_index: index, edges, code: "MESH_HOLE_NO_TRIANGULATION" });
                    continue;
                };
                let mut patch_faces: BTreeSet<u32> = patch.triangles.iter().map(|&[a, b, c]| mesh.add_face(a, b, c)).collect();
                let inserted =
                    if options.refine { refine_patch(&mut mesh, &mut patch_faces, &mut sigma, options.alpha) } else { Vec::new() };
                fair_vertices(&mut mesh, &inserted, options.fairing);
                let area = patch_faces.iter().fold(0.0, |sum, &f| {
                    let [a, b, c] = mesh.corners(f);
                    sum + length(normal_of(mesh.p(a), mesh.p(b), mesh.p(c))) / 2.0
                });
                filled.push(FilledHole {
                    loop_index: index,
                    edges,
                    triangles: patch_faces.len(),
                    added_vertices: inserted.len(),
                    area,
                    triangulation: if patch.method == Method::Dp { "dp" } else { "greedy" },
                    fairing: options.fairing,
                });
            }
        }
    }
    let (positions, triangles) = mesh.to_mesh();
    FillResult { positions, triangles, total_loops: topology.loops.len(), filled, skipped, not_found, explicit }
}
