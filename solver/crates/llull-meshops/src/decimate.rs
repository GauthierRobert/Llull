//! Quadric-error edge-collapse decimation (twin of `decimate.ts`, Garland and Heckbert 1997) with the 07 MSH stop rules: a triangle target
//! and / or an absolute one-sided deviation bound. The result mesh is bit-identical to the TypeScript engine's (VC-MSH-32): the same candidate
//! is collapsed at every step, with the same position and sums. The queue is one entry per edge (`edge_heap.rs`) instead of a stream of
//! versioned pushes, which yields the same sequence of valid candidates with a fraction of the heap work.

use crate::collapse_check::{check_collapse, valid_collapse, DeviationGuard, Outcome, Probe, ProbeUpdate, Scratch, Verdict};
use crate::edge_heap::{Candidate, EdgeHeap};
use crate::edit::EditMesh;
use crate::geom::{diagonal, length, normal_of, Sphere, Vec3};
use crate::quadric::{add_into, optimal_position, plane_quadric, quadric_cost, Quadric};
use crate::surface::SurfaceIndex;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;

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

/// The most checks held ahead at once so far in this process (reported by the perf test; the refill is skipped at four batches).
pub static PEAK_SPECS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Candidates checked ahead in one parallel batch (13.27).
const SPECULATION_BATCH: usize = 1024;

/// A check of a candidate made ahead of its turn, on the state as it was at `epoch`.
struct Spec {
    keep: u32,
    at: Vec3,
    outcome: Outcome,
    updates: Vec<ProbeUpdate>,
    epoch: u32,
    #[cfg(any(test, debug_assertions))]
    fp: u64,
    /// Every vertex whose faces or probes the check read: the 1-ring of the edge. A collapse changes the vertices at or next to the two it merges (`touched`).
    reads: Reads,
}

/// Up to [`Reads::CAPACITY`] vertices, inline (a check of a vertex of a higher valence is not kept: it is made again when its turn comes).
#[derive(Clone, Copy)]
struct Reads {
    list: [u32; Reads::CAPACITY],
    len: u8,
    overflow: bool,
}

impl Reads {
    const CAPACITY: usize = 24;

    fn iter(&self) -> impl Iterator<Item = u32> + '_ {
        self.list[..self.len as usize].iter().copied()
    }
}

struct Decimator {
    mesh: EditMesh,
    quadrics: Vec<Quadric>,
    locked: Vec<bool>,
    guard: Option<DeviationGuard>,
    heap: EdgeHeap,
    /// Per vertex: neighbours whose edge was popped and refused and has not been queued again (listed under both ends). The TypeScript engine queues
    /// every edge at a vertex again whenever a collapse changes that vertex's neighbourhood; the other edges are still in the queue.
    refused: Vec<Vec<(u32, f64)>>,
    /// Collapses applied so far, and per vertex the number of the last one that changed it or one of its neighbours.
    epoch: u32,
    touched: Vec<u32>,
    /// The checks made ahead, by edge (13.27).
    specs: HashMap<u64, Spec, std::hash::BuildHasherDefault<crate::collapse_check::EdgeHasher>>,
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

    /// The edge `a`-`b` was popped with `cost` and refused. Its cost cannot change until a collapse keeps one of its ends (which empties the lists of that end), so it is
    /// remembered with it and the edge is queued again with the same cost instead of a recomputed one.
    fn refuse(&mut self, a: u32, b: u32, cost: f64) {
        self.refused[a as usize].push((b, cost));
        self.refused[b as usize].push((a, cost));
    }

    /// Empties the refused list of `v` and returns it, with `v` struck from the lists of its entries.
    fn take_refused(&mut self, v: u32) -> Vec<(u32, f64)> {
        let list = std::mem::take(&mut self.refused[v as usize]);
        for &(x, _) in &list {
            self.refused[x as usize].retain(|&(y, _)| y != v);
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
            for (x, cost) in self.take_refused(w) {
                self.heap.upsert(w.min(x), w.max(x), cost);
            }
        }
    }
}

/// The vertices whose faces a check of the edge `u`-`v` reads: the edge and its rings (the 1-ring). A collapse of `removed` into `kept` changes the faces of exactly the vertices next
/// to either of them and moves `kept`; a vertex that check reads the position of is next to one of these, so a check is stale exactly when a collapse touched (`mark_changed`) one of them.
fn reads_of(mesh: &EditMesh, u: u32, v: u32) -> Reads {
    let mut reads = Reads { list: [0; Reads::CAPACITY], len: 0, overflow: false };
    for w in [u, v] {
        for &f in &mesh.v_faces[w as usize] {
            for c in mesh.corners(f) {
                if !reads.list[..reads.len as usize].contains(&c) {
                    if reads.len as usize == Reads::CAPACITY {
                        reads.overflow = true;
                    } else {
                        reads.list[reads.len as usize] = c;
                        reads.len += 1;
                    }
                }
            }
        }
    }
    reads
}

/// Everything a check of the edge `a`-`b` reads, hashed: the quadrics and lock flags of its ends and, for every vertex of its 1-ring, its faces, their corners and the position bits of the
/// corners, and the ids of the probes it owns. A check taken ahead must find this unchanged when its turn comes (debug builds and tests assert it: a stale check taken is a wrong answer).
#[cfg(any(test, debug_assertions))]
fn fingerprint(state: &Decimator, a: u32, b: u32) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    state.quadrics[a as usize].map(f64::to_bits).hash(&mut h);
    state.quadrics[b as usize].map(f64::to_bits).hash(&mut h);
    (state.locked[a as usize], state.locked[b as usize]).hash(&mut h);
    for w in reads_of(&state.mesh, a, b).iter() {
        w.hash(&mut h);
        for &f in &state.mesh.v_faces[w as usize] {
            f.hash(&mut h);
            for c in state.mesh.corners(f) {
                c.hash(&mut h);
                state.mesh.p(c).map(f64::to_bits).hash(&mut h);
            }
        }
        if let Some(guard) = &state.guard {
            for probe in &guard.owned[w as usize] {
                probe.id.hash(&mut h);
            }
        }
    }
    h.finish()
}

impl Decimator {
    /// The check of the edge `a`-`b` made ahead of its turn, when nothing it read has changed since.
    fn take_spec(&mut self, a: u32, b: u32) -> Option<Spec> {
        let spec = self.specs.remove(&(((a as u64) << 32) | b as u64))?;
        (!spec.reads.overflow && spec.reads.iter().all(|w| self.touched[w as usize] <= spec.epoch)).then_some(spec)
    }

    /// Checks `first` and the cheapest edges of the queue in parallel against the current state (read only: the caches they would store come back with the check and are stored
    /// when it is used, in queue order, so the result does not depend on the number of threads).
    fn speculate(&mut self, first: (u32, u32), area_floor: f64, off: bool) {
        let epoch = self.epoch;
        let touched = std::mem::take(&mut self.touched);
        self.specs.retain(|_, spec| !spec.reads.overflow && spec.reads.iter().all(|w| touched[w as usize] <= spec.epoch));
        self.touched = touched;
        let mut ahead = Vec::new();
        self.heap.smallest(speculation_batch(), &mut ahead);
        let mut edges: Vec<(u32, u32)> = vec![first];
        edges.extend(
            ahead
                .iter()
                .map(|c| (c.a, c.b))
                .filter(|&(a, b)| (a, b) != first && !self.specs.contains_key(&(((a as u64) << 32) | b as u64))),
        );
        PEAK_SPECS.fetch_max(self.specs.len(), std::sync::atomic::Ordering::Relaxed);
        let state: &Decimator = self;
        let checked: Vec<Spec> = edges
            .par_iter()
            .map_init(Scratch::default, |scratch, &(a, b)| {
                let (keep, at, _) = state.choose(a, b);
                let outcome = check_collapse(&state.mesh, area_floor, state.guard.as_ref(), scratch, (a, b), keep, at, off);
                Spec {
                    keep,
                    at,
                    outcome,
                    updates: scratch.updates.clone(),
                    epoch,
                    #[cfg(any(test, debug_assertions))]
                    fp: fingerprint(state, a, b),
                    reads: reads_of(&state.mesh, a, b),
                }
            })
            .collect();
        for (&(a, b), spec) in edges.iter().zip(checked) {
            self.specs.insert(((a as u64) << 32) | b as u64, spec);
        }
    }

    /// Marks what the collapse of `removed` into `kept` changed: both and every vertex next to either.
    fn mark_changed(&mut self, removed: u32, kept: u32, ring: &mut Vec<u32>) {
        self.epoch += 1;
        self.touched[removed as usize] = self.epoch;
        self.touched[kept as usize] = self.epoch;
        self.mesh.ring_into(kept, ring);
        for &w in ring.iter() {
            self.touched[w as usize] = self.epoch;
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
    let mut owned: Vec<Vec<Probe>> = vec![Vec::new(); mesh.vertex_total()];
    let mut next = 0u32;
    for v in 0..mesh.vertex_total() as u32 {
        if mesh.v_faces[v as usize].is_empty() {
            continue;
        }
        owned[v as usize].push(Probe::new(mesh.p(v), next));
        next += 1;
    }
    for f in 0..mesh.f_alive.len() as u32 {
        let [a, b, c] = mesh.corners(f).map(|v| mesh.p(v));
        let centre = [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, (a[2] + b[2] + c[2]) / 3.0];
        owned[mesh.corners(f)[0] as usize].push(Probe::new(centre, next));
        next += 1;
    }
    DeviationGuard::new(max_deviation, owned, SurfaceIndex::new(positions, triangles), mesh.f_alive.len())
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
        epoch: 0,
        touched: vec![0; vertex_total],
        specs: HashMap::default(),
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
    let speculate = state.guard.is_some() && !speculation_disabled() && rayon::current_num_threads() > 2;
    let mut since_batch = 0usize;
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
        let mut ahead = None;
        if speculate {
            // the cheapest edges are checked ahead in parallel when fewer than a quarter of a batch are left; an edge the queue just got (a requeued one) is checked alone
            since_batch += 1;
            if state.specs.len() < 4 * speculation_batch()
                && (state.specs.len() < speculation_batch() / 4 || since_batch >= speculation_batch())
            {
                since_batch = 0;
                state.speculate((a, b), area_floor, crate::collapse_check::caches_off());
            }
            ahead = state.take_spec(a, b);
            #[cfg(any(test, debug_assertions))]
            if let Some(spec) = &ahead {
                assert_eq!(spec.fp, fingerprint(&state, a, b), "the check of {a}-{b} was taken ahead though something it read had changed");
            }
        }
        let (keep, at, verdict) = match (ahead, state.guard.as_mut()) {
            (Some(spec), Some(guard)) => {
                guard.apply((a, b), spec.keep, &spec.updates, &spec.outcome);
                (spec.keep, spec.at, spec.outcome.verdict)
            }
            _ => {
                let (keep, at, _) = state.choose(a, b);
                (keep, at, valid_collapse(&state.mesh, area_floor, state.guard.as_mut(), &mut scratch, (a, b), keep, at))
            }
        };
        match verdict {
            Verdict::Ok => {}
            Verdict::Gone => continue,
            Verdict::Link => rejected.link += 1,
            Verdict::FoldOver => rejected.fold_over += 1,
            Verdict::Deviation => rejected.deviation += 1,
        }
        if verdict != Verdict::Ok {
            state.refuse(a, b, item.cost);
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
        if let Some(guard) = &mut state.guard {
            guard.touch(&state.mesh, keep, removed);
            guard.prune_blame(removed, &ring);
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
        if speculate {
            state.mark_changed(removed, keep, &mut ring);
        }
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

// Test switches: while set on a thread, the checks are not made ahead (`SPECULATION_OFF`), or in batches of this many (`BATCH_OVERRIDE`, 0 = the default) (13.27), so a test can run the same decimation with and without them.
#[cfg(test)]
thread_local! {
    pub static SPECULATION_OFF: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub static BATCH_OVERRIDE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn speculation_batch() -> usize {
    match BATCH_OVERRIDE.with(std::cell::Cell::get) {
        0 => SPECULATION_BATCH,
        n => n,
    }
}

#[cfg(not(test))]
const fn speculation_batch() -> usize {
    SPECULATION_BATCH
}

#[cfg(test)]
fn speculation_disabled() -> bool {
    SPECULATION_OFF.with(std::cell::Cell::get)
}

#[cfg(not(test))]
const fn speculation_disabled() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::{decimate, DecimateParams, DecimateReport};
    use crate::collapse_check::CACHES_OFF;
    use std::collections::HashMap;

    fn stream(seed: u64) -> impl FnMut() -> f64 {
        let mut state = seed;
        move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    /// An icosphere of radius 10, `level` times subdivided, every vertex pushed along its radius by up to `noise`.
    fn noisy_sphere(level: usize, noise: f64, seed: u64) -> (Vec<f64>, Vec<u32>) {
        let t = (1.0 + 5.0f64.sqrt()) / 2.0;
        let mut points: Vec<[f64; 3]> = vec![
            [-1.0, t, 0.0],
            [1.0, t, 0.0],
            [-1.0, -t, 0.0],
            [1.0, -t, 0.0],
            [0.0, -1.0, t],
            [0.0, 1.0, t],
            [0.0, -1.0, -t],
            [0.0, 1.0, -t],
            [t, 0.0, -1.0],
            [t, 0.0, 1.0],
            [-t, 0.0, -1.0],
            [-t, 0.0, 1.0],
        ];
        let mut faces: Vec<[u32; 3]> = vec![
            [0, 11, 5],
            [0, 5, 1],
            [0, 1, 7],
            [0, 7, 10],
            [0, 10, 11],
            [1, 5, 9],
            [5, 11, 4],
            [11, 10, 2],
            [10, 7, 6],
            [7, 1, 8],
            [3, 9, 4],
            [3, 4, 2],
            [3, 2, 6],
            [3, 6, 8],
            [3, 8, 9],
            [4, 9, 5],
            [2, 4, 11],
            [6, 2, 10],
            [8, 6, 7],
            [9, 8, 1],
        ];
        for _ in 0..level {
            let mut cache: HashMap<(u32, u32), u32> = HashMap::new();
            let mut next = Vec::new();
            for f in &faces {
                let mut mid = [0u32; 3];
                for k in 0..3 {
                    let (a, b) = (f[k], f[(k + 1) % 3]);
                    mid[k] = *cache.entry((a.min(b), a.max(b))).or_insert_with(|| {
                        let (p, q) = (points[a as usize], points[b as usize]);
                        points.push([(p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0, (p[2] + q[2]) / 2.0]);
                        points.len() as u32 - 1
                    });
                }
                next.extend([[f[0], mid[0], mid[2]], [f[1], mid[1], mid[0]], [f[2], mid[2], mid[1]], [mid[0], mid[1], mid[2]]]);
            }
            faces = next;
        }
        let mut random = stream(seed);
        let positions = points
            .iter()
            .flat_map(|p| {
                let n = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
                let r = 10.0 + (random() * 2.0 - 1.0) * noise;
                [p[0] / n * r, p[1] / n * r, p[2] / n * r]
            })
            .collect();
        (positions, faces.into_iter().flatten().collect())
    }

    /// A wavy open grid of `n` x `n` cells on [0, 10]^2 with some cells left out (holes), noise added to z.
    fn noisy_grid(n: usize, noise: f64, seed: u64) -> (Vec<f64>, Vec<u32>) {
        let mut random = stream(seed);
        let h = 10.0 / n as f64;
        let mut positions = Vec::new();
        for j in 0..=n {
            for i in 0..=n {
                let (x, y) = (i as f64 * h, j as f64 * h);
                positions.extend([x, y, 0.4 * (x / 1.5).sin() * (y / 2.0).cos() + (random() - 0.5) * noise]);
            }
        }
        let id = |i: usize, j: usize| (j * (n + 1) + i) as u32;
        let mut indices = Vec::new();
        for j in 0..n {
            for i in 0..n {
                if (i * 7 + j * 3) % 29 != 0 {
                    indices.extend([id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
                }
            }
        }
        (positions, indices)
    }

    fn run(mesh: &(Vec<f64>, Vec<u32>), params: &DecimateParams, caches_off: bool) -> (Vec<f64>, Vec<u32>, String) {
        CACHES_OFF.with(|flag| flag.set(caches_off));
        let (positions, indices, report): (Vec<f64>, Vec<u32>, DecimateReport) = decimate(&mesh.0, &mesh.1, params, &mut |_| {});
        CACHES_OFF.with(|flag| flag.set(false));
        (positions, indices, serde_json::to_string(&report).unwrap())
    }

    /// 13.16.4: the witnesses, the blamed probe and the hints are caches, so decimating with and without them gives the same bytes and the same report (the counts of every kind
    /// of refusal included, which fixes the sequence of verdicts), whatever the bound, the target, the boundary rule and the feature angle.
    #[test]
    fn the_deviation_caches_change_neither_the_bytes_nor_the_refusals() {
        let mut random = stream(2026);
        let mut deviations_refused = 0;
        for case in 0..50 {
            let mesh = if case % 3 == 2 {
                noisy_grid(12 + case % 9, 0.05 * (1 + case % 3) as f64, 100 + case as u64)
            } else {
                noisy_sphere(1 + case % 3, 0.1 * (1 + case % 4) as f64, 200 + case as u64)
            };
            let bound = [0.02, 0.05, 0.1, 0.3, 0.8][(random() * 5.0) as usize];
            let triangles = mesh.1.len() / 3;
            let params = DecimateParams {
                target_triangles: (case % 2 == 0).then(|| (triangles as f64 * (0.2 + 0.5 * random())) as usize),
                max_deviation: Some(bound),
                preserve_boundary: case % 4 != 1,
                feature_cos: (case % 5 == 0).then_some(0.9),
                locked_region: None,
            };
            let with = run(&mesh, &params, false);
            let without = run(&mesh, &params, true);
            assert_eq!(with.2, without.2, "case {case}: the report differs");
            assert!(with.0 == without.0 && with.1 == without.1, "case {case}: the bytes differ");
            deviations_refused += serde_json::from_str::<serde_json::Value>(&with.2).unwrap()["rejected"]["deviation"].as_u64().unwrap();
        }
        assert!(
            deviations_refused > 500,
            "the cases refuse {deviations_refused} collapses by the deviation guard: too few to test the caches"
        );
    }

    /// 13.27: checking the cheapest candidates ahead, in parallel, is a cache of verdicts that are re-made when anything they read changed, so decimating with and without it, on one
    /// thread and on several, gives the same bytes and the same report.
    #[test]
    fn checking_ahead_changes_neither_the_bytes_nor_the_refusals_whatever_the_thread_count() {
        use crate::decimate::{BATCH_OVERRIDE, SPECULATION_OFF};
        let pools: Vec<rayon::ThreadPool> =
            [1, 3, 8].iter().map(|&threads| rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap()).collect();
        let mut random = stream(77);
        let mut deviations_refused = 0;
        for case in 0..14 {
            let mesh = match case % 3 {
                0 => noisy_sphere(4, 0.1, 300 + case as u64),
                1 => noisy_grid(40 + case % 7, 0.06, 400 + case as u64),
                _ => noisy_sphere(3, 0.2, 500 + case as u64),
            };
            let triangles = mesh.1.len() / 3;
            let params = DecimateParams {
                target_triangles: (case % 4 == 1).then(|| (triangles as f64 * (0.2 + 0.5 * random())) as usize),
                max_deviation: Some([0.03, 0.08, 0.4][(random() * 3.0) as usize]),
                preserve_boundary: case % 4 != 3,
                feature_cos: (case % 5 == 0).then_some(0.9),
                locked_region: None,
            };
            SPECULATION_OFF.with(|flag| flag.set(true));
            let plain = run(&mesh, &params, false);
            SPECULATION_OFF.with(|flag| flag.set(false));
            let ahead = run(&mesh, &params, false);
            assert_eq!(plain.2, ahead.2, "case {case}: the report differs");
            assert!(plain.0 == ahead.0 && plain.1 == ahead.1, "case {case}: the bytes differ");
            for pool in &pools {
                let on_pool = pool.install(|| run(&mesh, &params, false));
                assert!(
                    on_pool.0 == plain.0 && on_pool.1 == plain.1 && on_pool.2 == plain.2,
                    "case {case}: {} threads differ",
                    pool.current_num_threads()
                );
            }
            for batch in [8, 40] {
                // inside a pool of 3 and of 8 threads (the flags are thread-local: set on the worker that runs the loop)
                for pool in &pools[1..] {
                    let small = pool.install(|| {
                        BATCH_OVERRIDE.with(|flag| flag.set(batch));
                        let r = run(&mesh, &params, false);
                        BATCH_OVERRIDE.with(|flag| flag.set(0));
                        r
                    });
                    assert!(
                        small.0 == plain.0 && small.1 == plain.1 && small.2 == plain.2,
                        "case {case}: batches of {batch} on {} threads differ",
                        pool.current_num_threads()
                    );
                }
            }
            let no_caches = pools[1].install(|| run(&mesh, &params, true));
            assert!(
                no_caches.0 == plain.0 && no_caches.1 == plain.1 && no_caches.2 == plain.2,
                "case {case}: ahead without the caches differs"
            );
            deviations_refused += serde_json::from_str::<serde_json::Value>(&plain.2).unwrap()["rejected"]["deviation"].as_u64().unwrap();
        }
        assert!(deviations_refused > 1000, "the cases refuse {deviations_refused} collapses by the deviation guard: too few");
    }

    /// 13.27: a sphere of 20,480 triangles with a bound that refuses thousands of collapses, checked ahead in batches of 64 (many checks go stale) and of 1,024: the same bytes as without.
    #[test]
    fn stale_checks_are_made_again_on_a_larger_sphere() {
        use crate::decimate::{BATCH_OVERRIDE, SPECULATION_OFF};
        let mesh = noisy_sphere(5, 0.1, 9);
        let params = DecimateParams {
            target_triangles: None,
            max_deviation: Some(0.06),
            preserve_boundary: true,
            feature_cos: None,
            locked_region: None,
        };
        SPECULATION_OFF.with(|flag| flag.set(true));
        let plain = run(&mesh, &params, false);
        SPECULATION_OFF.with(|flag| flag.set(false));
        let pool = rayon::ThreadPoolBuilder::new().num_threads(4).build().unwrap();
        for batch in [0, 64] {
            let ahead = pool.install(|| {
                BATCH_OVERRIDE.with(|flag| flag.set(batch));
                let r = run(&mesh, &params, false);
                BATCH_OVERRIDE.with(|flag| flag.set(0));
                r
            });
            assert!(ahead.0 == plain.0 && ahead.1 == plain.1 && ahead.2 == plain.2, "batches of {batch} differ");
        }
    }
}
