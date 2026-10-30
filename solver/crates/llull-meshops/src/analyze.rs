//! Numeric inspector of an indexed triangle mesh (twin of `analyzeIndexedMesh` in `analysis.ts`, 07 MSH FR-MSH-03): counts, topology, shells, boundary loops,
//! orientation, area, volume, quality. The sums run in the same order as the TypeScript ones (faces ascending, shells in their numbering), so the numbers are
//! bit-identical; the per-face metrics are computed in parallel and reduced sequentially. The self-intersection search stays in TypeScript.

use crate::geom::{diagonal, dot, js_max, js_min, length, Vec3};
use crate::topology::{build_topology, Topology, NO_SHELL};
use llull_jsmath::{acos, hypot};
use rayon::prelude::*;
use serde::Serialize;

#[derive(Debug, Serialize)]
struct LoopSummary {
    edges: usize,
    length: f64,
    centroid: Vec3,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellSummary {
    faces: usize,
    vertices: usize,
    edges: usize,
    closed: bool,
    euler_characteristic: i64,
    genus: Option<i64>,
    area: f64,
    volume: Option<f64>,
}

#[derive(Debug, Serialize)]
struct NonManifoldEdge {
    a: u32,
    b: u32,
    uses: usize,
}

#[derive(Debug, Serialize)]
struct EdgeLength {
    min: f64,
    max: f64,
    mean: f64,
}

#[derive(Debug, Serialize)]
struct AspectRatio {
    max: f64,
    mean: f64,
}

#[derive(Debug, Serialize)]
struct Bounds {
    min: Vec3,
    max: Vec3,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    vertices: usize,
    edges: usize,
    faces: usize,
    euler_characteristic: i64,
    genus: Option<i64>,
    closed: bool,
    manifold: bool,
    orientation_consistent: bool,
    boundary_edges: usize,
    boundary_loop_count: usize,
    boundary_loops: Vec<LoopSummary>,
    non_manifold_edge_count: usize,
    non_manifold_edges: Vec<NonManifoldEdge>,
    shell_count: usize,
    shells: Vec<ShellSummary>,
    degenerate_faces: usize,
    duplicate_faces: usize,
    area: f64,
    volume: Option<f64>,
    centroid: Option<Vec3>,
    /// Always null here: the pair search is not ported (the host refuses `selfIntersections` for this engine).
    self_intersection_pairs: Option<usize>,
    self_intersections: Vec<[usize; 2]>,
    edge_length: EdgeLength,
    aspect_ratio: AspectRatio,
    min_angle_deg: f64,
    bounds: Bounds,
    diagonal: f64,
}

struct FaceMetrics {
    area: f64,
    signed_volume: f64,
    volume_centroid: Vec3,
    aspect: f64,
    min_angle: f64,
    edges: [f64; 3],
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn face_metrics(pa: Vec3, pb: Vec3, pc: Vec3) -> FaceMetrics {
    let normal = cross(sub(pb, pa), sub(pc, pa));
    let area = hypot(&normal) / 2.0;
    let edges = [length(sub(pb, pa)), length(sub(pc, pb)), length(sub(pa, pc))];
    let perimeter = edges[0] + edges[1] + edges[2];
    let inradius = if perimeter > 0.0 { (2.0 * area) / perimeter } else { 0.0 };
    let longest = js_max(js_max(edges[0], edges[1]), edges[2]);
    let angle = |adjacent1: f64, adjacent2: f64, opposite: f64| {
        if adjacent1 * adjacent2 > 0.0 {
            acos(js_max(
                -1.0,
                js_min(1.0, (adjacent1 * adjacent1 + adjacent2 * adjacent2 - opposite * opposite) / (2.0 * adjacent1 * adjacent2)),
            ))
        } else {
            0.0
        }
    };
    let min_angle =
        js_min(js_min(angle(edges[0], edges[2], edges[1]), angle(edges[0], edges[1], edges[2])), angle(edges[1], edges[2], edges[0]));
    let signed_volume = dot(pa, cross(pb, pc)) / 6.0;
    let volume_centroid = [
        (signed_volume * (pa[0] + pb[0] + pc[0])) / 4.0,
        (signed_volume * (pa[1] + pb[1] + pc[1])) / 4.0,
        (signed_volume * (pa[2] + pb[2] + pc[2])) / 4.0,
    ];
    let aspect = if inradius > 0.0 { longest / (2.0 * 3f64.sqrt() * inradius) } else { f64::INFINITY };
    FaceMetrics { area, signed_volume, volume_centroid, aspect, min_angle, edges }
}

fn bounds(positions: &[f64]) -> Bounds {
    if positions.is_empty() {
        return Bounds { min: [0.0; 3], max: [0.0; 3] };
    }
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for p in positions.chunks_exact(3) {
        for axis in 0..3 {
            if p[axis] < min[axis] {
                min[axis] = p[axis];
            }
            if p[axis] > max[axis] {
                max[axis] = p[axis];
            }
        }
    }
    Bounds { min, max }
}

/// Analyse a welded mesh (`triangles` index `positions`); lists are capped at `max_listed`.
pub fn analyze(positions: &[f64], triangles: &[u32], max_listed: usize) -> Analysis {
    let vertex_count = positions.len() / 3;
    let topology = build_topology(vertex_count, triangles);
    let corner = |v: u32| -> Vec3 { [positions[v as usize * 3], positions[v as usize * 3 + 1], positions[v as usize * 3 + 2]] };
    let metrics: Vec<FaceMetrics> = triangles.par_chunks_exact(3).map(|t| face_metrics(corner(t[0]), corner(t[1]), corner(t[2]))).collect();
    // faces of each shell, ascending (the degenerate faces belong to none)
    let mut shell_faces: Vec<Vec<u32>> = vec![Vec::new(); topology.shell_count];
    for (face, &shell) in topology.face_shell.iter().enumerate() {
        if shell != NO_SHELL {
            shell_faces[shell as usize].push(face as u32);
        }
    }
    let mut inconsistent_shell = vec![false; topology.shell_count];
    for &face in &topology.inconsistent_faces {
        inconsistent_shell[topology.face_shell[face as usize] as usize] = true;
    }
    let mut last_shell_of_vertex = vec![u32::MAX; vertex_count];
    let shells: Vec<ShellSummary> = shell_faces
        .iter()
        .enumerate()
        .map(|(shell, faces)| {
            let (mut area, mut volume, mut vertices) = (0.0, 0.0, 0usize);
            for &face in faces {
                for &v in &triangles[face as usize * 3..face as usize * 3 + 3] {
                    if last_shell_of_vertex[v as usize] != shell as u32 {
                        last_shell_of_vertex[v as usize] = shell as u32;
                        vertices += 1;
                    }
                }
                area += metrics[face as usize].area;
                volume += metrics[face as usize].signed_volume;
            }
            let closed = !topology.unclosed_shells[shell];
            let consistent = !inconsistent_shell[shell];
            let chi = vertices as i64 - topology.shell_edges[shell] as i64 + faces.len() as i64;
            ShellSummary {
                faces: faces.len(),
                vertices,
                edges: topology.shell_edges[shell],
                closed,
                euler_characteristic: chi,
                genus: (closed && consistent && chi % 2 == 0).then_some((2 - chi) / 2),
                area,
                volume: (closed && consistent).then_some(volume),
            }
        })
        .collect();
    let closed_volumes: Vec<f64> = shells.iter().filter_map(|s| s.volume).collect();
    let volume = (!closed_volumes.is_empty()).then(|| closed_volumes.iter().fold(0.0, |sum, v| sum + v));
    let centroid = volume.filter(|v| v.abs() > 0.0).map(|volume| {
        let mut weighted = [0.0; 3];
        for (shell, faces) in shell_faces.iter().enumerate() {
            if shells[shell].volume.is_none() {
                continue;
            }
            for &face in faces {
                let m = metrics[face as usize].volume_centroid;
                weighted = [weighted[0] + m[0], weighted[1] + m[1], weighted[2] + m[2]];
            }
        }
        [weighted[0] / volume, weighted[1] / volume, weighted[2] / volume]
    });
    let solid_faces = topology.face_count - topology.degenerate_faces;
    let closed = solid_faces > 0 && topology.boundary_edges.is_empty() && topology.non_manifold_edges.is_empty();
    let mut referenced = vec![false; vertex_count];
    for (face, t) in triangles.chunks_exact(3).enumerate() {
        if topology.face_shell[face] != NO_SHELL {
            for &v in t {
                referenced[v as usize] = true;
            }
        }
    }
    let referenced = referenced.iter().filter(|&&r| r).count();
    let finite: Vec<f64> = metrics.iter().map(|m| m.aspect).filter(|a| a.is_finite()).collect();
    let edge_lengths: Vec<f64> = metrics.iter().flat_map(|m| m.edges).collect();
    let edge_sum = edge_lengths.iter().fold(0.0, |s, v| s + v);
    let boundary_loops = topology.loops.iter().take(max_listed).map(|vertices| loop_summary(vertices, &corner)).collect();
    Analysis {
        vertices: referenced,
        edges: topology.edge_count,
        faces: topology.face_count,
        euler_characteristic: referenced as i64 - topology.edge_count as i64 + solid_faces as i64,
        genus: (closed && !shells.is_empty() && shells.iter().all(|s| s.genus.is_some()))
            .then(|| shells.iter().map(|s| s.genus.unwrap_or(0)).sum()),
        closed,
        manifold: topology.non_manifold_edges.is_empty(),
        orientation_consistent: topology.inconsistent_edges == 0,
        boundary_edges: topology.boundary_edges.len(),
        boundary_loop_count: topology.loops.len(),
        boundary_loops,
        non_manifold_edge_count: topology.non_manifold_edges.len(),
        non_manifold_edges: topology
            .non_manifold_edges
            .iter()
            .take(max_listed)
            .map(|&(a, b, uses)| NonManifoldEdge { a, b, uses })
            .collect(),
        shell_count: shells.len(),
        area: metrics.iter().fold(0.0, |sum, m| sum + m.area),
        shells: shells.into_iter().take(max_listed).collect(),
        degenerate_faces: topology.degenerate_faces,
        duplicate_faces: topology.duplicate_faces,
        volume,
        centroid,
        self_intersection_pairs: None,
        self_intersections: Vec::new(),
        edge_length: EdgeLength {
            min: if edge_lengths.is_empty() { 0.0 } else { edge_lengths.iter().fold(f64::INFINITY, |m, &v| js_min(m, v)) },
            max: edge_lengths.iter().fold(0.0, |m, &v| js_max(m, v)),
            mean: if edge_lengths.is_empty() { 0.0 } else { edge_sum / edge_lengths.len() as f64 },
        },
        aspect_ratio: AspectRatio {
            max: finite.iter().fold(0.0, |m, &a| js_max(m, a)),
            mean: if finite.is_empty() { 0.0 } else { finite.iter().fold(0.0, |s, a| s + a) / finite.len() as f64 },
        },
        min_angle_deg: if metrics.is_empty() {
            0.0
        } else {
            (metrics.iter().fold(f64::INFINITY, |m, f| js_min(m, f.min_angle)) * 180.0) / std::f64::consts::PI
        },
        bounds: bounds(positions),
        diagonal: diagonal(positions),
    }
}

/// The faces and the signed volume of each shell of `topology` (the volume is `None` when the shell is open, non-manifold or inconsistently wound), summed in
/// face order as `analyze` does: what `repair` needs to remove small shells.
pub(crate) fn shell_volumes(positions: &[f64], triangles: &[u32], topology: &Topology) -> Vec<(usize, Option<f64>)> {
    let corner = |v: u32| -> Vec3 { [positions[v as usize * 3], positions[v as usize * 3 + 1], positions[v as usize * 3 + 2]] };
    let mut shells: Vec<(usize, f64)> = vec![(0, 0.0); topology.shell_count];
    for (face, &shell) in topology.face_shell.iter().enumerate() {
        if shell == NO_SHELL {
            continue;
        }
        let t = &triangles[face * 3..face * 3 + 3];
        let (pa, pb, pc) = (corner(t[0]), corner(t[1]), corner(t[2]));
        shells[shell as usize].0 += 1;
        shells[shell as usize].1 += dot(pa, cross(pb, pc)) / 6.0;
    }
    let mut inconsistent = vec![false; topology.shell_count];
    for &face in &topology.inconsistent_faces {
        inconsistent[topology.face_shell[face as usize] as usize] = true;
    }
    shells
        .iter()
        .enumerate()
        .map(|(shell, &(faces, volume))| (faces, (!topology.unclosed_shells[shell] && !inconsistent[shell]).then_some(volume)))
        .collect()
}

fn loop_summary(vertices: &[u32], corner: &impl Fn(u32) -> Vec3) -> LoopSummary {
    let points: Vec<Vec3> = vertices.iter().map(|&v| corner(v)).collect();
    let n = points.len();
    let length = points.iter().enumerate().fold(0.0, |sum, (k, &p)| sum + hypot(&sub(points[(k + 1) % n], p)));
    let total = points.iter().fold([0.0; 3], |s, p| [s[0] + p[0], s[1] + p[1], s[2] + p[2]]);
    LoopSummary { edges: n, length, centroid: [total[0] / n as f64, total[1] / n as f64, total[2] / n as f64] }
}
