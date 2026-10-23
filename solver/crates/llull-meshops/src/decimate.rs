//! Quadric-error edge-collapse decimation (twin of `decimate.ts`, Garland and Heckbert 1997) with the 07 MSH stop rules: a triangle target
//! and / or an absolute one-sided deviation bound. Every comparison, sum and tie-break follows the TypeScript order, so the result mesh
//! is bit-identical to the TypeScript engine's (VC-MSH-32).

use crate::edit::EditMesh;
use crate::geom::{diagonal, dot, length, normal_of, Sphere, Vec3};
use crate::surface::SurfaceIndex;
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
    pub max_collapse_cost: f64,
}

type Quadric = [f64; 10];

fn plane_quadric(n: Vec3, point: Vec3, weight: f64) -> Quadric {
    let d = -(n[0] * point[0] + n[1] * point[1] + n[2] * point[2]);
    let p = [n[0], n[1], n[2], d];
    let mut q = [0.0; 10];
    let mut k = 0;
    for i in 0..4 {
        for j in i..4 {
            q[k] = weight * p[i] * p[j];
            k += 1;
        }
    }
    q
}

fn add_into(target: &mut Quadric, source: &Quadric) {
    for (t, s) in target.iter_mut().zip(source) {
        *t += s;
    }
}

fn quadric_cost(q: &Quadric, x: f64, y: f64, z: f64) -> f64 {
    q[0] * x * x
        + 2.0 * q[1] * x * y
        + 2.0 * q[2] * x * z
        + 2.0 * q[3] * x
        + q[4] * y * y
        + 2.0 * q[5] * y * z
        + 2.0 * q[6] * y
        + q[7] * z * z
        + 2.0 * q[8] * z
        + q[9]
}

fn optimal_position(q: &Quadric) -> Option<Vec3> {
    let (a, b, c, d, e, f) = (q[0], q[1], q[2], q[4], q[5], q[7]);
    let det = a * (d * f - e * e) - b * (b * f - c * e) + c * (b * e - c * d);
    let trace = a + d + f;
    // `!(x > y)` in the TypeScript engine: also true for NaN.
    if det.abs().partial_cmp(&(1e-12 * (trace * trace * trace))) != Some(std::cmp::Ordering::Greater) {
        return None;
    }
    let rhs = [-q[3], -q[6], -q[8]];
    let inv = [
        [d * f - e * e, c * e - b * f, b * e - c * d],
        [c * e - b * f, a * f - c * c, b * c - a * e],
        [b * e - c * d, b * c - a * e, a * d - b * b],
    ];
    let solve = |row: [f64; 3]| (row[0] * rhs[0] + row[1] * rhs[1] + row[2] * rhs[2]) / det;
    Some([solve(inv[0]), solve(inv[1]), solve(inv[2])])
}

/// Squared distance from `p` to triangle `abc` (Ericson 5.1.5).
fn point_triangle_sq(p: Vec3, a: Vec3, b: Vec3, c: Vec3) -> f64 {
    let (abx, aby, abz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    let (acx, acy, acz) = (c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    let (apx, apy, apz) = (p[0] - a[0], p[1] - a[1], p[2] - a[2]);
    let d1 = abx * apx + aby * apy + abz * apz;
    let d2 = acx * apx + acy * apy + acz * apz;
    let sq = |x: f64, y: f64, z: f64| x * x + y * y + z * z;
    if d1 <= 0.0 && d2 <= 0.0 {
        return sq(apx, apy, apz);
    }
    let (bpx, bpy, bpz) = (p[0] - b[0], p[1] - b[1], p[2] - b[2]);
    let d3 = abx * bpx + aby * bpy + abz * bpz;
    let d4 = acx * bpx + acy * bpy + acz * bpz;
    if d3 >= 0.0 && d4 <= d3 {
        return sq(bpx, bpy, bpz);
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return sq(apx - v * abx, apy - v * aby, apz - v * abz);
    }
    let (cpx, cpy, cpz) = (p[0] - c[0], p[1] - c[1], p[2] - c[2]);
    let d5 = abx * cpx + aby * cpy + abz * cpz;
    let d6 = acx * cpx + acy * cpy + acz * cpz;
    if d6 >= 0.0 && d5 <= d6 {
        return sq(cpx, cpy, cpz);
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return sq(apx - w * acx, apy - w * acy, apz - w * acz);
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        let w = (d4 - d3) / (d4 - d3 + (d5 - d6));
        return sq(bpx - w * (c[0] - b[0]), bpy - w * (c[1] - b[1]), bpz - w * (c[2] - b[2]));
    }
    let denominator = 1.0 / (va + vb + vc);
    let v = vb * denominator;
    let w = vc * denominator;
    sq(apx - v * abx - w * acx, apy - v * aby - w * acy, apz - v * abz - w * acz)
}

/// A heap entry. The vertex kept and its position are not stored: they are a pure function of the two vertices' quadrics and positions, which
/// are unchanged while the versions match, so `choose` recomputes the same answer when the entry is popped.
#[derive(Clone, Copy)]
struct Candidate {
    cost: f64,
    a: u32,
    b: u32,
    version_a: i32,
    version_b: i32,
}

fn less(x: &Candidate, y: &Candidate) -> bool {
    x.cost < y.cost || (x.cost == y.cost && (x.a < y.a || (x.a == y.a && x.b < y.b)))
}

#[derive(Default)]
struct Heap {
    items: Vec<Candidate>,
}

impl Heap {
    fn push(&mut self, item: Candidate) {
        self.items.push(item);
        let mut i = self.items.len() - 1;
        while i > 0 {
            let parent = (i - 1) >> 1;
            if !less(&self.items[i], &self.items[parent]) {
                break;
            }
            self.items.swap(i, parent);
            i = parent;
        }
    }

    fn pop(&mut self) -> Option<Candidate> {
        let top = self.items.first().cloned()?;
        let last = self.items.pop()?;
        if !self.items.is_empty() {
            self.items[0] = last;
            let mut i = 0;
            loop {
                let (l, r) = (2 * i + 1, 2 * i + 2);
                let mut smallest = i;
                if l < self.items.len() && less(&self.items[l], &self.items[smallest]) {
                    smallest = l;
                }
                if r < self.items.len() && less(&self.items[r], &self.items[smallest]) {
                    smallest = r;
                }
                if smallest == i {
                    break;
                }
                self.items.swap(i, smallest);
                i = smallest;
            }
        }
        Some(top)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Ok,
    Link,
    FoldOver,
    Deviation,
}

struct Decimator {
    mesh: EditMesh,
    area_floor: f64,
    max_deviation: Option<f64>,
    quadrics: Vec<Quadric>,
    locked: Vec<bool>,
    probes: Vec<Vec3>,
    owned: Vec<Vec<u32>>,
    original: Option<SurfaceIndex>,
    version: Vec<i32>,
    heap: Heap,
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
            let edge_length = length([pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]]);
            if let Some(o) = optimal_position(&sum) {
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

    fn push(&mut self, a0: u32, b0: u32) {
        let (a, b) = if a0 > b0 { (b0, a0) } else { (a0, b0) };
        if self.locked[a as usize] && self.locked[b as usize] {
            return;
        }
        let (_, _, best_cost) = self.choose(a, b);
        // JavaScript Math.max(0, x) is NaN for a NaN cost.
        let cost = if best_cost.is_nan() { best_cost } else { best_cost.max(0.0) };
        self.heap.push(Candidate { cost, a, b, version_a: self.version[a as usize], version_b: self.version[b as usize] });
    }

    fn valid_collapse(&self, u: u32, v: u32, keep: u32, at: Vec3) -> Verdict {
        let mesh = &self.mesh;
        let edge_faces = mesh.faces_on_edge(u, v);
        if edge_faces.is_empty() || edge_faces.len() > 2 {
            return Verdict::Link;
        }
        let (ring_u, ring_v) = (mesh.ring(u), mesh.ring(v));
        let common: Vec<u32> = ring_u.iter().copied().filter(|w| ring_v.contains(w)).collect();
        let mut apexes: Vec<u32> = edge_faces.iter().map(|&f| mesh.opposite(f, u, v)).collect();
        apexes.sort_unstable();
        if common.len() != apexes.len() || common.iter().zip(&apexes).any(|(w, x)| w != x) {
            return Verdict::Link;
        }
        if !mesh.is_boundary_edge(u, v) && mesh.is_boundary_vertex(u) && mesh.is_boundary_vertex(v) {
            return Verdict::Link;
        }
        let mut union: Vec<u32> = ring_u.iter().chain(ring_v.iter()).copied().collect();
        union.sort_unstable();
        union.dedup();
        if edge_faces.len() == 2 && union.len() as i64 - 2 <= 3 {
            return Verdict::Link;
        }
        let removed = if keep == u { v } else { u };
        let mut fan: Vec<[u32; 3]> = Vec::new();
        for w in [u, v] {
            for &f in &mesh.v_faces[w as usize] {
                if edge_faces.contains(&f) {
                    continue;
                }
                let [x, y, z] = mesh.corners(f);
                let swap = |c: u32| if c == removed { keep } else { c };
                let before = normal_of(mesh.p(x), mesh.p(y), mesh.p(z));
                let pos = |c: u32| if swap(c) == keep { at } else { mesh.p(c) };
                let after = normal_of(pos(x), pos(y), pos(z));
                if dot(before, after) <= 0.0 || length(after) / 2.0 <= self.area_floor {
                    return Verdict::FoldOver;
                }
                fan.push([swap(x), swap(y), swap(z)]);
            }
        }
        let Some(max_deviation) = self.max_deviation else { return Verdict::Ok };
        let mut affected: Vec<u32> = vec![keep];
        for &w in ring_u.iter().chain(ring_v.iter()) {
            if !affected.contains(&w) {
                affected.push(w);
            }
        }
        affected.retain(|&w| w != removed);
        let limit = max_deviation * max_deviation;
        let place = |c: u32| if c == keep { at } else { mesh.p(c) };
        if let Some(original) = &self.original {
            if original.closest_distance(at) > max_deviation {
                return Verdict::Deviation;
            }
            for &[x, y, z] in &fan {
                let (pa, pb, pc) = (place(x), place(y), place(z));
                let centre = [(pa[0] + pb[0] + pc[0]) / 3.0, (pa[1] + pb[1] + pc[1]) / 3.0, (pa[2] + pb[2] + pc[2]) / 3.0];
                if original.closest_distance(centre) > max_deviation {
                    return Verdict::Deviation;
                }
            }
        }
        for &o in &affected {
            let mut faces: Vec<[Vec3; 3]> = Vec::new();
            for &f in &mesh.v_faces[o as usize] {
                let [x, y, z] = mesh.corners(f);
                if x == u || x == v || y == u || y == v || z == u || z == v {
                    continue;
                }
                faces.push([mesh.p(x), mesh.p(y), mesh.p(z)]);
            }
            for triple in &fan {
                if triple.contains(&o) {
                    faces.push([place(triple[0]), place(triple[1]), place(triple[2])]);
                }
            }
            let owners: Vec<u32> = if o == keep {
                self.owned[keep as usize].iter().chain(self.owned[removed as usize].iter()).copied().collect()
            } else {
                self.owned[o as usize].clone()
            };
            for probe in owners {
                let p = self.probes[probe as usize];
                let mut nearest = f64::INFINITY;
                for [a, b, c] in &faces {
                    let d = point_triangle_sq(p, *a, *b, *c);
                    nearest = if nearest.is_nan() || d.is_nan() { f64::NAN } else { nearest.min(d) };
                }
                if nearest > limit {
                    return Verdict::Deviation;
                }
            }
        }
        Verdict::Ok
    }
}

/// Decimate a manifold, consistently wound, welded mesh; returns the canonical result and the report.
pub fn decimate(positions: &[f64], triangles: &[u32], params: &DecimateParams) -> (Vec<f64>, Vec<u32>, DecimateReport) {
    let mesh = EditMesh::new(positions, triangles);
    let triangles_before = mesh.live_faces;
    let diag = diagonal(positions);
    let area_floor = 1e-12 * diag * diag;
    let target = params.target_triangles.unwrap_or(0);
    let vertex_total = mesh.vertex_total();
    let mut quadrics: Vec<Quadric> = vec![[0.0; 10]; vertex_total];
    for f in 0..mesh.f_alive.len() as u32 {
        let Some(n) = unit_normal(&mesh, f) else { continue };
        let [a, b, c] = mesh.corners(f);
        let k = plane_quadric(n, mesh.p(a), 1.0);
        for v in [a, b, c] {
            add_into(&mut quadrics[v as usize], &k);
        }
    }
    let mut boundary_edges: Vec<(u32, u32, u32)> = Vec::new();
    let mut feature_edges: Vec<(u32, u32, u32, u32)> = Vec::new();
    for a in 0..vertex_total as u32 {
        for b in mesh.ring(a) {
            if b < a {
                continue;
            }
            let shared = mesh.faces_on_edge(a, b);
            if shared.len() == 1 {
                boundary_edges.push((a, b, shared[0]));
            } else if shared.len() == 2 {
                if let Some(cos_feature) = params.feature_cos {
                    if let (Some(n1), Some(n2)) = (unit_normal(&mesh, shared[0]), unit_normal(&mesh, shared[1])) {
                        if n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] < cos_feature {
                            feature_edges.push((a, b, shared[0], shared[1]));
                        }
                    }
                }
            }
        }
    }
    let mut state = Decimator {
        mesh,
        area_floor,
        max_deviation: params.max_deviation,
        quadrics,
        locked: vec![false; vertex_total],
        probes: Vec::new(),
        owned: vec![Vec::new(); vertex_total],
        original: params.max_deviation.map(|_| SurfaceIndex::new(positions, triangles)),
        version: vec![0; vertex_total],
        heap: Heap::default(),
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
    if state.max_deviation.is_some() {
        for v in 0..vertex_total as u32 {
            if state.mesh.v_faces[v as usize].is_empty() {
                continue;
            }
            state.probes.push(state.mesh.p(v));
            state.owned[v as usize].push((state.probes.len() - 1) as u32);
        }
        for f in 0..state.mesh.f_alive.len() as u32 {
            let [a, b, c] = state.mesh.corners(f).map(|v| state.mesh.p(v));
            state.probes.push([(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, (a[2] + b[2] + c[2]) / 3.0]);
            let first = state.mesh.corners(f)[0];
            state.owned[first as usize].push((state.probes.len() - 1) as u32);
        }
    }
    for a in 0..vertex_total as u32 {
        for b in state.mesh.ring(a) {
            if a < b {
                state.push(a, b);
            }
        }
    }
    let mut rejected = Rejected { link: 0, fold_over: 0, deviation: 0 };
    let mut collapses: u64 = 0;
    let mut max_cost = 0.0f64;
    let mut exhausted = true;
    while !state.heap.items.is_empty() {
        if target > 0 && state.mesh.live_faces <= target {
            exhausted = false;
            break;
        }
        let Some(item) = state.heap.pop() else { break };
        let (a, b) = (item.a, item.b);
        if !state.mesh.v_alive[a as usize] || !state.mesh.v_alive[b as usize] {
            continue;
        }
        if state.version[a as usize] != item.version_a || state.version[b as usize] != item.version_b {
            continue;
        }
        if state.mesh.faces_on_edge(a, b).is_empty() {
            continue;
        }
        let (keep, at, _) = state.choose(a, b);
        match state.valid_collapse(a, b, keep, at) {
            Verdict::Ok => {}
            Verdict::Link => {
                rejected.link += 1;
                continue;
            }
            Verdict::FoldOver => {
                rejected.fold_over += 1;
                continue;
            }
            Verdict::Deviation => {
                rejected.deviation += 1;
                continue;
            }
        }
        let removed = if keep == a { b } else { a };
        let kept = keep;
        let removed_quadric = state.quadrics[removed as usize];
        add_into(&mut state.quadrics[kept as usize], &removed_quadric);
        state.mesh.set_p(kept, at);
        state.mesh.collapse(removed, kept);
        let moved = std::mem::take(&mut state.owned[removed as usize]);
        state.owned[kept as usize].extend(moved);
        if state.locked[removed as usize] {
            state.locked[kept as usize] = true;
        }
        collapses += 1;
        max_cost = if max_cost.is_nan() || item.cost.is_nan() { f64::NAN } else { max_cost.max(item.cost) };
        let mut refresh: Vec<u32> = vec![kept];
        refresh.extend(state.mesh.ring(kept));
        for &w in &refresh {
            state.version[w as usize] += 1;
        }
        for &w in &refresh {
            for x in state.mesh.ring(w) {
                if w < x || !refresh.contains(&x) {
                    state.push(w, x);
                }
            }
        }
    }
    let triangles_after = state.mesh.live_faces;
    let reached = params.target_triangles.map(|t| triangles_after <= t);
    let stopped_by = if !exhausted {
        "target"
    } else if params.max_deviation.is_some() && state.heap.items.is_empty() && rejected.deviation > 0 {
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
            max_collapse_cost: max_cost,
        },
    )
}
