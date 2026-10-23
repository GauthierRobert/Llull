//! Umbrella-operator smoothing (twin of `smooth.ts`, Taubin 1995): Laplacian `x += lambda dx` or the Taubin pair lambda then
//! `mu = 1 / (kPB - 1 / lambda)`, simultaneous updates, uniform or cotangent weights normalised to sum 1, optional volume correction.
//! Operation order matches the TypeScript engine, so the positions are bit-identical (VC-MSH-32).

use crate::geom::{length, Sphere, Vec3};
use llull_jsmath::{cbrt, hypot};
use serde::Serialize;
use std::collections::BTreeSet;

pub struct SmoothParams {
    pub taubin: bool,
    pub lambda: f64,
    pub pass_band: f64,
    pub iterations: usize,
    pub cotangent: bool,
    pub fix_boundary: bool,
    pub volume_correction: bool,
    pub region: Option<Sphere>,
}

#[derive(Debug, Serialize)]
pub struct SmoothReport {
    pub mu: Option<f64>,
    #[serde(rename = "volumeBefore")]
    pub volume_before: Option<f64>,
    #[serde(rename = "volumeAfter")]
    pub volume_after: Option<f64>,
    #[serde(rename = "volumeCorrected")]
    pub volume_corrected: bool,
    #[serde(rename = "meanDisplacement")]
    pub mean_displacement: f64,
    #[serde(rename = "maxDisplacement")]
    pub max_displacement: f64,
}

struct Measure {
    closed: bool,
    volume: Option<f64>,
    centroid: Option<Vec3>,
}

fn point(positions: &[f64], v: u32) -> Vec3 {
    let i = v as usize * 3;
    [positions[i], positions[i + 1], positions[i + 2]]
}

/// Sorted undirected edge keys `min * V + max` of the non-degenerate faces.
fn edge_keys(vertex_count: u64, triangles: &[u32]) -> Vec<u64> {
    let mut keys = Vec::with_capacity(triangles.len());
    for t in triangles.chunks_exact(3) {
        let (a, b, c) = (u64::from(t[0]), u64::from(t[1]), u64::from(t[2]));
        if a == b || b == c || a == c {
            continue;
        }
        for (x, y) in [(a, b), (b, c), (c, a)] {
            keys.push(x.min(y) * vertex_count + x.max(y));
        }
    }
    keys.sort_unstable();
    keys
}

/// Closedness, signed volume and volume centroid, as `fastMeasure.ts`.
fn measure(positions: &[f64], triangles: &[u32]) -> Measure {
    let faces = triangles.len() / 3;
    let vertex_count = (positions.len() / 3) as u64;
    let mut keys: Vec<u64> = Vec::with_capacity(faces * 3);
    let (mut volume, mut cx_sum, mut cy_sum, mut cz_sum) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut degenerate = false;
    for t in triangles.chunks_exact(3) {
        let (a, b, c) = (t[0], t[1], t[2]);
        if a == b || b == c || a == c {
            degenerate = true;
        }
        let [ax, ay, az] = point(positions, a);
        let [bx, by, bz] = point(positions, b);
        let [cx, cy, cz] = point(positions, c);
        let signed = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6.0;
        volume += signed;
        cx_sum += (signed * (ax + bx + cx)) / 4.0;
        cy_sum += (signed * (ay + by + cy)) / 4.0;
        cz_sum += (signed * (az + bz + cz)) / 4.0;
        for (x, y) in [(a, b), (b, c), (c, a)] {
            let (x, y) = (u64::from(x), u64::from(y));
            keys.push((x.min(y) * vertex_count + x.max(y)) * 2 + u64::from(x < y));
        }
    }
    keys.sort_unstable();
    let (mut boundary, mut non_manifold, mut inconsistent) = (0u64, 0u64, 0u64);
    let mut i = 0;
    while i < keys.len() {
        let edge = keys[i] / 2;
        let mut end = i + 1;
        while end < keys.len() && keys[end] / 2 == edge {
            end += 1;
        }
        let uses = end - i;
        if uses == 1 {
            boundary += 1;
        } else if uses > 2 {
            non_manifold += 1;
        } else if keys[i] % 2 == keys[i + 1] % 2 {
            inconsistent += 1;
        }
        i = end;
    }
    let closed = faces > 0 && !degenerate && boundary == 0 && non_manifold == 0;
    let measured = closed && inconsistent == 0;
    Measure {
        closed,
        volume: measured.then_some(volume),
        centroid: (measured && volume != 0.0).then(|| [cx_sum / volume, cy_sum / volume, cz_sum / volume]),
    }
}

struct Graph {
    neighbours: Vec<Vec<u32>>,
    weights: Vec<Vec<f64>>,
}

fn uniform_graph(vertex_count: usize, triangles: &[u32]) -> Graph {
    let mut sets: Vec<BTreeSet<u32>> = vec![BTreeSet::new(); vertex_count];
    for t in triangles.chunks_exact(3) {
        for &a in t {
            for &b in t {
                if a != b {
                    sets[a as usize].insert(b);
                }
            }
        }
    }
    let neighbours: Vec<Vec<u32>> = sets.into_iter().map(|s| s.into_iter().collect()).collect();
    let weights = neighbours.iter().map(|n| vec![1.0 / n.len() as f64; n.len()]).collect();
    Graph { neighbours, weights }
}

fn cotangent(p: Vec3, q: Vec3, r: Vec3) -> f64 {
    let [ux, uy, uz] = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    let [vx, vy, vz] = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    let cross = hypot(&[uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
    if cross > 1e-300 {
        (ux * vx + uy * vy + uz * vz) / cross
    } else {
        0.0
    }
}

fn cotangent_graph(positions: &[f64], triangles: &[u32]) -> Graph {
    let vertex_count = positions.len() / 3;
    let mut raw: Vec<Vec<(u32, f64)>> = vec![Vec::new(); vertex_count];
    let mut accumulate = |at: u32, other: u32, w: f64| {
        let list = &mut raw[at as usize];
        match list.iter_mut().find(|(n, _)| *n == other) {
            Some(entry) => entry.1 += w,
            None => list.push((other, 0.0 + w)),
        }
    };
    for t in triangles.chunks_exact(3) {
        for k in 0..3 {
            let (apex, a, b) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);
            let w = cotangent(point(positions, apex), point(positions, a), point(positions, b)).max(1e-6);
            accumulate(a, b, w);
            accumulate(b, a, w);
        }
    }
    let mut neighbours = Vec::with_capacity(vertex_count);
    let mut weights = Vec::with_capacity(vertex_count);
    for mut list in raw {
        list.sort_by_key(|&(n, _)| n);
        let row: Vec<f64> = list.iter().map(|&(_, w)| w).collect();
        let sum = row.iter().fold(0.0, |s, w| s + w);
        neighbours.push(list.iter().map(|&(n, _)| n).collect());
        weights.push(row.iter().map(|w| w / sum).collect());
    }
    Graph { neighbours, weights }
}

fn umbrella_step(positions: &[f64], graph: &Graph, factor: f64, free: &[bool]) -> Vec<f64> {
    let mut next = positions.to_vec();
    for (v, &is_free) in free.iter().enumerate() {
        if !is_free {
            continue;
        }
        let row = &graph.neighbours[v];
        if row.is_empty() {
            continue;
        }
        for axis in 0..3 {
            let mut mean = 0.0;
            for (k, &j) in row.iter().enumerate() {
                mean += graph.weights[v][k] * positions[j as usize * 3 + axis];
            }
            next[v * 3 + axis] = positions[v * 3 + axis] + factor * (mean - positions[v * 3 + axis]);
        }
    }
    next
}

fn free_vertices(positions: &[f64], triangles: &[u32], params: &SmoothParams) -> Vec<bool> {
    let vertex_count = positions.len() / 3;
    let mut free = vec![true; vertex_count];
    let mut referenced = vec![false; vertex_count];
    for &v in triangles {
        referenced[v as usize] = true;
    }
    for (v, flag) in free.iter_mut().enumerate() {
        let inside = params.region.is_none_or(|r| r.contains(point(positions, v as u32)));
        if !referenced[v] || !inside {
            *flag = false;
        }
    }
    let keys = edge_keys(vertex_count as u64, triangles);
    let mut i = 0;
    while i < keys.len() {
        let mut end = i + 1;
        while end < keys.len() && keys[end] == keys[i] {
            end += 1;
        }
        let uses = end - i;
        let (a, b) = ((keys[i] / vertex_count as u64) as usize, (keys[i] % vertex_count as u64) as usize);
        if (uses == 1 && params.fix_boundary) || uses > 2 {
            free[a] = false;
            free[b] = false;
        }
        i = end;
    }
    free
}

/// Smooth `positions` (welded, `triangles`); returns the new positions and the report.
pub fn smooth(positions: &[f64], triangles: &[u32], params: &SmoothParams) -> (Vec<f64>, SmoothReport) {
    let vertex_count = positions.len() / 3;
    let free = free_vertices(positions, triangles, params);
    let graph = if params.cotangent { cotangent_graph(positions, triangles) } else { uniform_graph(vertex_count, triangles) };
    let mu = params.taubin.then(|| 1.0 / (params.pass_band - 1.0 / params.lambda));
    let mut current = positions.to_vec();
    for _ in 0..params.iterations {
        current = umbrella_step(&current, &graph, params.lambda, &free);
        if let Some(mu) = mu {
            current = umbrella_step(&current, &graph, mu, &free);
        }
    }
    let before = measure(positions, triangles);
    let mut volume_corrected = false;
    if params.volume_correction && before.closed {
        if let Some(before_volume) = before.volume.filter(|v| *v != 0.0) {
            let smoothed = measure(&current, triangles);
            if let (Some(volume), Some(centre)) = (smoothed.volume, smoothed.centroid) {
                if volume * before_volume > 0.0 {
                    let factor = cbrt(before_volume / volume);
                    for (i, value) in current.iter_mut().enumerate() {
                        if free[i / 3] {
                            let c = centre[i % 3];
                            *value = c + factor * (*value - c);
                        }
                    }
                    volume_corrected = true;
                }
            }
        }
    }
    let after = measure(&current, triangles);
    let mut referenced = vec![false; vertex_count];
    for &v in triangles {
        referenced[v as usize] = true;
    }
    let (mut sum, mut max, mut moved) = (0.0f64, 0.0f64, 0u64);
    for (v, &used) in referenced.iter().enumerate() {
        if !used {
            continue;
        }
        let d = length([
            current[v * 3] - positions[v * 3],
            current[v * 3 + 1] - positions[v * 3 + 1],
            current[v * 3 + 2] - positions[v * 3 + 2],
        ]);
        sum += d;
        max = max.max(d);
        moved += 1;
    }
    let report = SmoothReport {
        mu,
        volume_before: before.volume,
        volume_after: after.volume,
        volume_corrected,
        mean_displacement: if moved > 0 { sum / moved as f64 } else { 0.0 },
        max_displacement: max,
    };
    (current, report)
}
