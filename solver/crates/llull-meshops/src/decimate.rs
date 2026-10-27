//! Quadric-error edge-collapse decimation (twin of `decimate.ts`, Garland and Heckbert 1997) with the 07 MSH stop rules: a triangle target
//! and / or an absolute one-sided deviation bound. The result mesh is bit-identical to the TypeScript engine's (VC-MSH-32): the same candidate
//! is collapsed at every step, with the same position and sums. The queue is one entry per edge (`edge_heap.rs`) instead of a stream of
//! versioned pushes, which yields the same sequence of valid candidates with a fraction of the heap work.

use crate::collapse_check::{valid_collapse, DeviationGuard, Scratch, Verdict};
use crate::edge_heap::{Candidate, EdgeHeap};
use crate::edit::EditMesh;
use crate::geom::{diagonal, length, normal_of, Sphere, Vec3};
use crate::quadric::{add_into, optimal_position, plane_quadric, quadric_cost, Quadric};
use crate::surface::SurfaceIndex;
use rayon::prelude::*;
use serde::Serialize;

const PENALTY: f64 = 1000.0;

pub struct DecimateParams {
    pub target_triangles: Option<usize>,
    pub max_deviation: Option<f64>,
    pub preserve_boundary: bool,
    /// Cosine of the feature angle (computed by the host: `Math.cos` is not reproduced here).
    pub feature_cos: Option<f64>,
    pub locked_region: Option<Sphere>,
}

#[derive(Debug, Serialize)]
pub struct Rejected {
    pub link: u64,
    #[serde(rename = "foldOver")]
    pub fold_over: u64,
    pub deviation: u64,
}

#[derive(Debug, Serialize)]
pub struct DecimateReport {
    #[serde(rename = "trianglesBefore")]
    pub triangles_before: usize,
    #[serde(rename = "trianglesAfter")]
    pub triangles_after: usize,
    pub collapses: u64,
    #[serde(rename = "reachedTarget")]
    pub reached_target: Option<bool>,
    #[serde(rename = "stoppedBy")]
    pub stopped_by: &'static str,
    pub rejected: Rejected,
    #[serde(rename = "maxCollapseCost")]
    /// Largest cost of a collapse made; null when a NaN cost was collapsed.
    pub max_collapse_cost: Option<f64>,
}

struct Decimator {
    mesh: EditMesh,
    quadrics: Vec<Quadric>,
    locked: Vec<bool>,
    guard: Option<DeviationGuard>,
    heap: EdgeHeap,
    /// Per vertex: neighbours whose edge was popped and refused and has not been queued again (listed under both ends). The TypeScript engine queues
    /// every edge at a vertex again whenever a collapse changes that vertex's neighbourhood; the other edges are still in the queue.
    refused: Vec<Vec<u32>>,
}

fn unit_normal(mesh: &EditMesh, f: u32) -> Option<Vec3> {
    let n = mesh.face_normal(f);
    let l = length(n);
    (l > 0.0).then(|| [n[0] / l, n[1] / l, n[2] / l])
}

impl Decimator {
    fn penalise(&mut self, a: u32, b: u32, face: u32) {
        let Some(n) = unit_normal(&self.mesh, face) else { return };
        let (pa, pb) = (self.mesh.p(a), self.mesh.p(b));
        let edge = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        let side = normal_of([0.0, 0.0, 0.0], edge, n);
        let l = length(side);
        if l == 0.0 {
            return;
        }
        let k = plane_quadric([side[0] / l, side[1] / l, side[2] / l], pa, PENALTY);
        add_into(&mut self.quadrics[a as usize], &k);
        add_into(&mut self.quadrics[b as usize], &k);
    }

    /// The vertex that survives collapsing the edge `a`-`b` (a < b), where it goes, and the quadric cost there.
    fn choose(&self, a: u32, b: u32) -> (u32, Vec3, f64) {
        let mut sum = [0.0; 10];
        add_into(&mut sum, &self.quadrics[a as usize]);
        add_into(&mut sum, &self.quadrics[b as usize]);
        let mut options: [(u32, Vec3); 4] = [(a, [0.0; 3]); 4];
        let mut count = 0;
        if self.locked[a as usize] {
            options[0] = (a, self.mesh.p(a));
            count = 1;
        } else if self.locked[b as usize] {
            options[0] = (b, self.mesh.p(b));
            count = 1;
        } else {
            let (pa, pb) = (self.mesh.p(a), self.mesh.p(b));
            let mid = [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0, (pa[2] + pb[2]) / 2.0];
            if let Some(o) = optimal_position(&sum) {
                let edge_length = length([pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]]);
                if length([o[0] - mid[0], o[1] - mid[1], o[2] - mid[2]]) <= 2.0 * edge_length {
                    options[count] = (a, o);
                    count += 1;
                }
            }
            for option in [(a, pa), (b, pb), (a, mid)] {
                options[count] = option;
                count += 1;
            }
        }
        let mut best = options[0];
        let mut best_cost = quadric_cost(&sum, best.1[0], best.1[1], best.1[2]);
        for option in &options[1..count] {
            let cost = quadric_cost(&sum, option.1[0], option.1[1], option.1[2]);
            if cost < best_cost - 1e-18 {
                best = *option;
                best_cost = cost;
            }
        }
        (best.0, best.1, best_cost)
    }

    /// The cost the edge `a` < `b` is queued with; none for an edge between two locked vertices, which is never queued.
    fn queue_cost(&self, a: u32, b: u32) -> Option<f64> {
        if self.locked[a as usize] && self.locked[b as usize] {
            return None;
        }
        let (_, _, best_cost) = self.choose(a, b);
        // JavaScript Math.max(0, x) is NaN for a NaN cost.
        Some(if best_cost.is_nan() { best_cost } else { best_cost.max(0.0) })
    }

    /// Queues the edge `a`-`b` with its current cost, or takes it out when it must not be queued.
    fn queue(&mut self, a0: u32, b0: u32) {
        let (a, b) = if a0 > b0 { (b0, a0) } else { (a0, b0) };
        match self.queue_cost(a, b) {
            Some(cost) => self.heap.upsert(a, b, cost),
            None => {
                self.heap.remove(a, b);
            }
        }
    }

    fn refuse(&mut self, a: u32, b: u32) {
        self.refused[a as usize].push(b);
        self.refused[b as usize].push(a);
    }

    /// Empties the refused list of `v` and returns it, with `v` struck from the lists of its entries.
    fn take_refused(&mut self, v: u32) -> Vec<u32> {
        let list = std::mem::take(&mut self.refused[v as usize]);
        for &x in &list {
            self.refused[x as usize].retain(|&y| y != v);
        }
        list
    }

    /// After `removed` was merged into `kept` (whose quadric and position are already final): the queue holds exactly what the TypeScript
    /// engine's would, i.e. every edge at `kept` or at one of its neighbours is queued with its current cost.
    fn requeue_around(&mut self, removed: u32, kept: u32, ring: &mut Vec<u32>) {
        self.take_refused(removed);
        self.take_refused(kept);
        self.mesh.ring_into(kept, ring);
        for &x in ring.iter() {
            self.queue(kept, x);
        }
        for &w in ring.iter() {
            if self.refused[w as usize].is_empty() {
                continue;
            }
            for x in self.take_refused(w) {
                self.queue(w, x);
            }
        }
    }
}

/// Heap pops between two `progress` calls of [`decimate`].
const PROGRESS_EVERY: u64 = 2048;

/// Per-vertex quadrics of the planes of the live faces.
fn face_quadrics(mesh: &EditMesh) -> Vec<Quadric> {
    let mut quadrics: Vec<Quadric> = vec![[0.0; 10]; mesh.vertex_total()];
    for f in 0..mesh.f_alive.len() as u32 {
        let Some(n) = unit_normal(mesh, f) else { continue };
        let [a, b, c] = mesh.corners(f);
        let k = plane_quadric(n, mesh.p(a), 1.0);
        for v in [a, b, c] {
            add_into(&mut quadrics[v as usize], &k);
        }
    }
    quadrics
}

/// Vertices handled by one parallel task of the set-up scans.
const CHUNK: usize = 4096;

/// Runs `per_chunk` over consecutive vertex ranges in parallel; the results come back in vertex order, so they do not depend on the thread count.
fn over_vertices<T: Send>(vertex_total: usize, per_chunk: impl Fn(std::ops::Range<u32>) -> T + Sync) -> Vec<T> {
    (0..vertex_total.div_ceil(CHUNK))
        .into_par_iter()
        .map(|chunk| per_chunk((chunk * CHUNK) as u32..((chunk + 1) * CHUNK).min(vertex_total) as u32))
        .collect()
}

/// Edges the decimation treats apart, each once with a < b, in vertex order.
struct SpecialEdges {
    /// (a, b, its face)
    boundary: Vec<(u32, u32, u32)>,
    /// With a feature angle: sharp interior edges (a, b, their two faces).
    features: Vec<(u32, u32, u32, u32)>,
}

fn special_edges(mesh: &EditMesh, feature_cos: Option<f64>) -> SpecialEdges {
    let chunks = over_vertices(mesh.vertex_total(), |vertices| {
        let (mut boundary, mut features) = (Vec::new(), Vec::new());
        let (mut ring, mut shared) = (Vec::new(), Vec::new());
        for a in vertices {
            mesh.ring_into(a, &mut ring);
            for &b in ring.iter().filter(|&&b| b > a) {
                mesh.faces_on_edge_into(a, b, &mut shared);
                if shared.len() == 1 {
                    boundary.push((a, b, shared[0]));
                } else if let (2, Some(cos_feature)) = (shared.len(), feature_cos) {
                    if let (Some(n1), Some(n2)) = (unit_normal(mesh, shared[0]), unit_normal(mesh, shared[1])) {
                        if n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] < cos_feature {
                            features.push((a, b, shared[0], shared[1]));
                        }
                    }
                }
            }
        }
        (boundary, features)
    });
    let (boundary, features): (Vec<_>, Vec<_>) = chunks.into_iter().unzip();
    SpecialEdges { boundary: boundary.concat(), features: features.concat() }
}

/// Every edge that is queued at the start, with its cost, in (a, b) order.
fn initial_edges(state: &Decimator) -> Vec<Candidate> {
    over_vertices(state.mesh.vertex_total(), |vertices| {
        let (mut ring, mut edges) = (Vec::new(), Vec::new());
        for a in vertices {
            state.mesh.ring_into(a, &mut ring);
            for &b in ring.iter().filter(|&&b| b > a) {
                if let Some(cost) = state.queue_cost(a, b) {
                    edges.push(Candidate { cost, a, b });
                }
            }
        }
        edges
    })
    .concat()
}

/// The one-sided guard of `max_deviation`: a probe at every used vertex and every triangle centre of the original mesh.
fn deviation_guard(mesh: &EditMesh, positions: &[f64], triangles: &[u32], max_deviation: f64) -> DeviationGuard {
    let mut guard = DeviationGuard {
        max_deviation,
        probes: Vec::new(),
        owned: vec![Vec::new(); mesh.vertex_total()],
        original: SurfaceIndex::new(positions, triangles),
    };
    for v in 0..mesh.vertex_total() as u32 {
        if mesh.v_faces[v as usize].is_empty() {
            continue;
        }
        guard.probes.push(mesh.p(v));
        guard.owned[v as usize].push((guard.probes.len() - 1) as u32);
    }
    for f in 0..mesh.f_alive.len() as u32 {
        let [a, b, c] = mesh.corners(f).map(|v| mesh.p(v));
        guard.probes.push([(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, (a[2] + b[2] + c[2]) / 3.0]);
        let first = mesh.corners(f)[0];
        guard.owned[first as usize].push((guard.probes.len() - 1) as u32);
    }
    guard
}

/// Decimate a manifold, consistently wound, welded mesh; returns the canonical result and the report. `progress` is told the share of the collapse
/// loop done (0 to 1) now and then; it never changes the result.
pub fn decimate(
    positions: &[f64],
    triangles: &[u32],
    params: &DecimateParams,
    progress: &mut dyn FnMut(f64),
) -> (Vec<f64>, Vec<u32>, DecimateReport) {
    let mesh = EditMesh::new(positions, triangles);
    let triangles_before = mesh.live_faces;
    let diag = diagonal(positions);
    let area_floor = 1e-12 * diag * diag;
    let target = params.target_triangles.unwrap_or(0);
    let vertex_total = mesh.vertex_total();
    let quadrics = face_quadrics(&mesh);
    let SpecialEdges { boundary: boundary_edges, features: feature_edges } = special_edges(&mesh, params.feature_cos);
    let guard = params.max_deviation.map(|bound| deviation_guard(&mesh, positions, triangles, bound));
    let mut state = Decimator {
        mesh,
        quadrics,
        locked: vec![false; vertex_total],
        guard,
        heap: EdgeHeap::default(),
        refused: vec![Vec::new(); vertex_total],
    };
    for &(a, b, face) in &boundary_edges {
        if params.preserve_boundary {
            state.locked[a as usize] = true;
            state.locked[b as usize] = true;
        } else {
            state.penalise(a, b, face);
        }
    }
    for &(a, b, f1, f2) in &feature_edges {
        state.penalise(a, b, f1);
        state.penalise(a, b, f2);
    }
    if let Some(region) = &params.locked_region {
        for v in 0..vertex_total as u32 {
            if region.contains(state.mesh.p(v)) {
                state.locked[v as usize] = true;
            }
        }
    }
    state.heap = EdgeHeap::from_edges(&initial_edges(&state));
    let mut ring = Vec::new();
    let mut rejected = Rejected { link: 0, fold_over: 0, deviation: 0 };
    let mut collapses: u64 = 0;
    let mut max_cost = 0.0f64;
    let initial_pairs = state.heap.len().max(1);
    let mut scratch = Scratch::default();
    let mut pops: u64 = 0;
    while !state.heap.is_empty() {
        pops += 1;
        if pops.is_multiple_of(PROGRESS_EVERY) {
            let done = if target > 0 && triangles_before > target {
                (triangles_before - state.mesh.live_faces.min(triangles_before)) as f64 / (triangles_before - target) as f64
            } else {
                1.0 - state.heap.len() as f64 / initial_pairs as f64
            };
            progress(done.clamp(0.0, 1.0));
        }
        if target > 0 && state.mesh.live_faces <= target {
            break;
        }
        let Some(item) = state.heap.pop() else { break };
        let (a, b) = (item.a, item.b);
        let (keep, at, _) = state.choose(a, b);
        let verdict = valid_collapse(&state.mesh, area_floor, state.guard.as_ref(), &mut scratch, (a, b), keep, at);
        match verdict {
            Verdict::Ok => {}
            Verdict::Gone => continue,
            Verdict::Link => rejected.link += 1,
            Verdict::FoldOver => rejected.fold_over += 1,
            Verdict::Deviation => rejected.deviation += 1,
        }
        if verdict != Verdict::Ok {
            state.refuse(a, b);
            continue;
        }
        let removed = if keep == a { b } else { a };
        let removed_quadric = state.quadrics[removed as usize];
        add_into(&mut state.quadrics[keep as usize], &removed_quadric);
        state.mesh.set_p(keep, at);
        state.mesh.ring_into(removed, &mut ring);
        for &x in &ring {
            state.heap.remove(removed.min(x), removed.max(x));
        }
        state.mesh.collapse(removed, keep);
        if let Some(guard) = &mut state.guard {
            let moved = std::mem::take(&mut guard.owned[removed as usize]);
            guard.owned[keep as usize].extend(moved);
        }
        if state.locked[removed as usize] {
            state.locked[keep as usize] = true;
        }
        collapses += 1;
        max_cost = if max_cost.is_nan() || item.cost.is_nan() { f64::NAN } else { max_cost.max(item.cost) };
        state.requeue_around(removed, keep, &mut ring);
    }
    let triangles_after = state.mesh.live_faces;
    let reached = params.target_triangles.map(|t| triangles_after <= t);
    let stopped_by = if target > 0 && triangles_after <= target {
        "target"
    } else if params.max_deviation.is_some() && state.heap.is_empty() && rejected.deviation > 0 {
        "deviation_or_validity"
    } else {
        "exhausted"
    };
    let (out_positions, out_indices) = state.mesh.to_mesh();
    (
        out_positions,
        out_indices,
        DecimateReport {
            triangles_before,
            triangles_after,
            collapses,
            reached_target: reached,
            stopped_by,
            rejected,
            max_collapse_cost: (!max_cost.is_nan()).then_some(max_cost),
        },
    )
}
