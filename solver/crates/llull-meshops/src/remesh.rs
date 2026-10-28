//! Isotropic and adaptive remeshing (twin of `remesh.ts`, Botsch and Kobbelt 2004): per iteration split edges longer than 4/3 L, collapse edges shorter
//! than 4/5 L, flip toward valence 6 (4 on constraints), relax tangentially, project onto the input surface. The result mesh and the report are
//! bit-identical to the TypeScript engine's: the same edges are visited in the same order, the per-vertex face lists keep JavaScript `Set` order
//! (`edit.rs`) because the relaxation sums them, and the V8 `Math` functions are the twins of `llull-jsmath`.

use crate::edit::EditMesh;
use crate::geom::{dist, dot, js_max, js_min, length, normal_of, or_one, Vec3};
use crate::remesh_quality::{acceptable, edge_key, midpoint, quality, sizing_field, summarize, Kind, Sizing, VertexStats, QUALITY_FLOOR};
pub use crate::remesh_types::{Adaptive, EdgeStats, RemeshParams, RemeshReport, Remeshed, MAX_TRIANGLES};
use crate::surface::SurfaceIndex;
use llull_jsmath::acos;
use rayon::prelude::*;
use std::collections::HashSet;

const HIGH: f64 = 4.0 / 3.0;
const LOW: f64 = 4.0 / 5.0;
const CLOSING_PASSES: usize = 12;

struct Remesher<'a> {
    mesh: EditMesh,
    feature: HashSet<u64>,
    splits: u64,
    collapses: u64,
    flips: u64,
    reference: SurfaceIndex,
    reference_triangles: &'a [u32],
    sizing: Sizing,
    params: &'a RemeshParams,
    exceeded: bool,
}

impl<'a> Remesher<'a> {
    fn new(positions: &[f64], triangles: &'a [u32], params: &'a RemeshParams) -> Self {
        let mesh = EditMesh::new(positions, triangles);
        let sizing = match (params.target_edge, params.adaptive) {
            (Some(edge), _) => Sizing::Uniform(edge),
            (None, Some(adaptive)) => Sizing::Field { sizes: sizing_field(positions, triangles, adaptive), max_edge: adaptive.max_edge },
            (None, None) => Sizing::Uniform(f64::NAN),
        };
        let mut remesher = Self {
            mesh,
            feature: HashSet::new(),
            splits: 0,
            collapses: 0,
            flips: 0,
            reference: SurfaceIndex::new(positions, triangles),
            reference_triangles: triangles,
            sizing,
            params,
            exceeded: false,
        };
        remesher.find_feature_edges();
        remesher
    }

    fn find_feature_edges(&mut self) {
        let mut ring = Vec::new();
        let mut shared = Vec::new();
        for a in 0..self.mesh.vertex_total() as u32 {
            self.mesh.ring_into(a, &mut ring);
            for &b in &ring {
                if b < a {
                    continue;
                }
                self.mesh.faces_on_edge_into(a, b, &mut shared);
                if shared.len() != 2 {
                    continue;
                }
                let (n1, n2) = (self.mesh.face_normal(shared[0]), self.mesh.face_normal(shared[1]));
                let l = length(n1) * length(n2);
                if l > 0.0 && dot(n1, n2) / l < self.params.feature_cos {
                    self.feature.insert(edge_key(a, b));
                }
            }
        }
    }

    fn ring(&self, v: u32) -> Vec<u32> {
        let mut ring = Vec::new();
        self.mesh.ring_into(v, &mut ring);
        ring
    }

    fn faces_on_edge(&self, a: u32, b: u32) -> Vec<u32> {
        let mut faces = Vec::new();
        self.mesh.faces_on_edge_into(a, b, &mut faces);
        faces
    }

    /// Target edge length at point `p`.
    fn size(&self, p: Vec3) -> f64 {
        match &self.sizing {
            Sizing::Uniform(edge) => *edge,
            Sizing::Field { sizes, max_edge } => {
                let hit = self.reference.closest(p);
                if hit.face < 0 {
                    return *max_edge;
                }
                let [u, v, w] = self.reference.barycentric(hit.face as usize, hit.point);
                let f = hit.face as usize * 3;
                let s = |k: usize| sizes[self.reference_triangles[f + k] as usize];
                u * s(0) + v * s(1) + w * s(2)
            }
        }
    }

    fn edge_target(&self, a: u32, b: u32) -> f64 {
        self.size(midpoint(self.mesh.p(a), self.mesh.p(b)))
    }

    fn movable(&self, v: u32) -> bool {
        self.params.region.is_none_or(|region| region.contains(self.mesh.p(v)))
    }

    fn neighbours(&self, v: u32) -> Vec<(u32, u32)> {
        let mut ring = Vec::new();
        self.mesh.neighbours_into(v, &mut ring);
        ring
    }

    /// The neighbours of `v` joined by a constrained edge: a feature edge or a boundary edge (an edge of one face), `feature_only` leaving out the latter.
    fn constrained_among<'b>(&'b self, v: u32, ring: &'b [(u32, u32)], feature_only: bool) -> impl Iterator<Item = u32> + 'b {
        ring.iter().filter_map(move |&(w, faces)| {
            let on_feature = self.feature.contains(&edge_key(v, w));
            (on_feature || (faces == 1 && !feature_only)).then_some(w)
        })
    }

    fn is_constrained_edge(&self, a: u32, b: u32) -> bool {
        self.feature.contains(&edge_key(a, b)) || self.mesh.is_boundary_edge(a, b)
    }

    /// Valence, boundary flag and number of constrained edges of `v` (one pass over its ring).
    fn vertex_stats(&self, v: u32) -> VertexStats {
        let ring = self.neighbours(v);
        let constrained = self.constrained_among(v, &ring, self.params.preserve_boundary).count();
        (ring.len() as i64, ring.iter().any(|&(_, faces)| faces == 1), constrained)
    }

    /// The vertices a constrained line leaves `v` through.
    fn line_neighbours(&self, v: u32) -> Vec<u32> {
        let ring = self.neighbours(v);
        self.constrained_among(v, &ring, self.params.preserve_boundary).collect()
    }

    fn kind(&self, v: u32) -> Kind {
        if !self.movable(v) {
            return Kind::Fixed;
        }
        let ring = self.neighbours(v);
        if self.params.preserve_boundary && ring.iter().any(|&(_, faces)| faces == 1) {
            return Kind::Fixed;
        }
        let mut line = self.constrained_among(v, &ring, self.params.preserve_boundary);
        let Some(a) = line.next() else { return Kind::Free };
        let (Some(b), None) = (line.next(), line.next()) else { return Kind::Fixed };
        let (p, pa, pb) = (self.mesh.p(v), self.mesh.p(a), self.mesh.p(b));
        let u = [pa[0] - p[0], pa[1] - p[1], pa[2] - p[2]];
        let w = [pb[0] - p[0], pb[1] - p[1], pb[2] - p[2]];
        let cosine = dot(u, w) / or_one(length(u) * length(w));
        if std::f64::consts::PI - acos(js_max(-1.0, js_min(1.0, cosine))) > self.params.feature_angle {
            Kind::Fixed
        } else {
            Kind::Slide
        }
    }

    fn all_edges(&self) -> Vec<(u32, u32)> {
        let mut edges = Vec::new();
        let mut ring = Vec::new();
        for a in 0..self.mesh.vertex_total() as u32 {
            if !self.mesh.v_alive[a as usize] {
                continue;
            }
            self.mesh.ring_into(a, &mut ring);
            edges.extend(ring.iter().filter(|&&b| a < b).map(|&b| (a, b)));
        }
        edges
    }

    /// True when a vertex opposite the edge `a`-`b` is closer to `at` than `fraction` of the edge `length`.
    fn crowded(&self, a: u32, b: u32, at: Vec3, fraction: f64, length: f64) -> bool {
        self.faces_on_edge(a, b).into_iter().any(|f| dist(self.mesh.p(self.mesh.opposite(f, a, b)), at) < fraction * length)
    }

    fn split_long(&mut self) -> usize {
        let mut count = 0;
        for (a, b) in self.all_edges() {
            if self.mesh.live_faces > self.params.max_triangles {
                self.exceeded = true;
                break;
            }
            if self.faces_on_edge(a, b).is_empty() || !self.movable(a) || !self.movable(b) {
                continue;
            }
            let (pa, pb) = (self.mesh.p(a), self.mesh.p(b));
            let length = dist(pa, pb);
            if length <= HIGH * self.edge_target(a, b) {
                continue;
            }
            let was_feature = self.feature.contains(&edge_key(a, b));
            let middle = midpoint(pa, pb);
            let mut at = middle;
            if self.params.project && !was_feature && !self.mesh.is_boundary_edge(a, b) {
                at = self.reference.closest(at).point;
            }
            if self.crowded(a, b, at, 0.1, length) {
                if self.flip_if_valid(a, b) {
                    self.flips += 1;
                    continue;
                }
                at = middle;
                if self.crowded(a, b, at, 1e-3, length) {
                    continue;
                }
            }
            let m = self.mesh.split(a, b, at);
            if was_feature {
                self.feature.remove(&edge_key(a, b));
                self.feature.insert(edge_key(a, m));
                self.feature.insert(edge_key(m, b));
            }
            count += 1;
        }
        self.splits += count as u64;
        count
    }

    fn can_collapse(&self, r: u32, k: u32, at: Vec3) -> bool {
        let mesh = &self.mesh;
        let shared = self.faces_on_edge(r, k);
        if shared.is_empty() || shared.len() > 2 {
            return false;
        }
        let (ring_r, ring_k) = (self.ring(r), self.ring(k));
        let common: Vec<u32> = ring_r.iter().copied().filter(|w| ring_k.contains(w)).collect();
        let mut apexes: Vec<u32> = shared.iter().map(|&f| mesh.opposite(f, r, k)).collect();
        apexes.sort_unstable();
        if common != apexes {
            return false;
        }
        if !mesh.is_boundary_edge(r, k) && mesh.is_boundary_vertex(r) && mesh.is_boundary_vertex(k) {
            return false;
        }
        if shared.len() == 2 {
            let union: HashSet<u32> = ring_r.iter().chain(ring_k.iter()).copied().collect();
            if union.len() <= 5 {
                return false;
            }
        }
        if ring_r.iter().any(|&w| w != k && dist(at, mesh.p(w)) > HIGH * self.edge_target(w, k)) {
            return false;
        }
        for owner in [r, k] {
            for &f in &mesh.v_faces[owner as usize] {
                if shared.contains(&f) {
                    continue;
                }
                let [x, y, z] = mesh.corners(f);
                let pos = |c: u32| if c == r || c == k { at } else { mesh.p(c) };
                if !acceptable([mesh.p(x), mesh.p(y), mesh.p(z)], [pos(x), pos(y), pos(z)]) {
                    return false;
                }
            }
        }
        true
    }

    fn collapse_short(&mut self) -> usize {
        let mut count = 0;
        for (a, b) in self.all_edges() {
            if !self.mesh.v_alive[a as usize] || !self.mesh.v_alive[b as usize] || self.faces_on_edge(a, b).is_empty() {
                continue;
            }
            if dist(self.mesh.p(a), self.mesh.p(b)) >= LOW * self.edge_target(a, b) {
                continue;
            }
            let constrained = self.is_constrained_edge(a, b);
            for (r, k) in [(b, a), (a, b)] {
                let (kr, kk) = (self.kind(r), self.kind(k));
                if kr == Kind::Fixed || (kr == Kind::Slide && !(constrained && kk != Kind::Free)) || (kr == Kind::Free && constrained) {
                    continue;
                }
                let at = if kr == Kind::Free && kk == Kind::Free { midpoint(self.mesh.p(r), self.mesh.p(k)) } else { self.mesh.p(k) };
                if !self.can_collapse(r, k, at) {
                    continue;
                }
                for w in self.ring(r) {
                    if self.feature.remove(&edge_key(r, w)) && w != k {
                        self.feature.insert(edge_key(k, w));
                    }
                }
                self.mesh.set_p(k, at);
                self.mesh.collapse(r, k);
                count += 1;
                break;
            }
        }
        self.collapses += count as u64;
        count
    }

    /// Flip the interior non-feature edge a-b when the quad is convex enough that both new faces are acceptable.
    fn flip_if_valid(&mut self, a: u32, b: u32) -> bool {
        let mesh = &self.mesh;
        let shared = self.faces_on_edge(a, b);
        if shared.len() != 2 || self.feature.contains(&edge_key(a, b)) {
            return false;
        }
        let (c, d) = (mesh.opposite(shared[0], a, b), mesh.opposite(shared[1], a, b));
        if c == d || !self.faces_on_edge(c, d).is_empty() || ![a, b, c, d].iter().all(|&v| self.movable(v)) {
            return false;
        }
        let (pa, pb, pc, pd) = (mesh.p(a), mesh.p(b), mesh.p(c), mesh.p(d));
        let old_faces: Vec<[Vec3; 3]> = shared.iter().map(|&f| mesh.corners(f).map(|v| mesh.p(v))).collect();
        let reference = old_faces[0];
        let quad = if mesh.has_directed(shared[0], a, b) { [[pa, pd, pc], [pd, pb, pc]] } else { [[pa, pc, pd], [pc, pb, pd]] };
        if dist(pc, pd) > HIGH * self.edge_target(c, d) && dist(pc, pd) > dist(pa, pb) {
            return false;
        }
        let floor = old_faces.iter().fold(QUALITY_FLOOR, |least, o| js_min(least, quality(o[0], o[1], o[2])));
        if !quad.iter().all(|t| acceptable(reference, *t) && quality(t[0], t[1], t[2]) >= floor) {
            return false;
        }
        self.mesh.flip(a, b)
    }

    fn flip_edges(&mut self) -> usize {
        let mut count = 0;
        let mut shared = Vec::new();
        // A flip changes the valence of its four vertices and nothing else the statistics read, so they are kept until a flip touches the vertex.
        let mut cache: Vec<Option<VertexStats>> = vec![None; self.mesh.vertex_total()];
        for (a, b) in self.all_edges() {
            if !self.mesh.v_alive[a as usize] || !self.mesh.v_alive[b as usize] {
                continue;
            }
            self.mesh.faces_on_edge_into(a, b, &mut shared);
            if shared.len() != 2 {
                continue;
            }
            let (c, d) = (self.mesh.opposite(shared[0], a, b), self.mesh.opposite(shared[1], a, b));
            let mut stats = |v: u32| *cache[v as usize].get_or_insert_with(|| self.vertex_stats(v));
            let (stats_a, stats_b) = (stats(a), stats(b));
            if stats_a.0 <= 3 || stats_b.0 <= 3 {
                continue;
            }
            let (stats_c, stats_d) = (stats(c), stats(d));
            let deviation = |(valence, boundary, constrained): (i64, bool, usize), delta: i64| {
                let target = if boundary || constrained > 0 { 4 } else { 6 };
                (valence + delta - target).pow(2)
            };
            let before = deviation(stats_a, 0) + deviation(stats_b, 0) + deviation(stats_c, 0) + deviation(stats_d, 0);
            let after = deviation(stats_a, -1) + deviation(stats_b, -1) + deviation(stats_c, 1) + deviation(stats_d, 1);
            if after >= before {
                continue;
            }
            if self.flip_if_valid(a, b) {
                count += 1;
                for v in [a, b, c, d] {
                    cache[v as usize] = None;
                }
            }
        }
        self.flips += count as u64;
        count
    }

    fn vertex_normal(&self, v: u32) -> Vec3 {
        let mut n = [0.0; 3];
        for &f in &self.mesh.v_faces[v as usize] {
            let face = self.mesh.face_normal(f);
            n = [n[0] + face[0], n[1] + face[1], n[2] + face[2]];
        }
        let l = or_one(length(n));
        [n[0] / l, n[1] / l, n[2] / l]
    }

    /// Where the relaxation wants `v` (`None`: it stays).
    fn relaxed(&self, v: u32, kind: Kind) -> Option<Vec3> {
        let p = self.mesh.p(v);
        if kind == Kind::Free {
            let mut weight = 0.0;
            let mut q = [0.0; 3];
            for &f in &self.mesh.v_faces[v as usize] {
                let [a, b, c] = self.mesh.corners(f).map(|x| self.mesh.p(x));
                let w = length(normal_of(a, b, c)) / 2.0;
                q = [
                    q[0] + (w * (a[0] + b[0] + c[0])) / 3.0,
                    q[1] + (w * (a[1] + b[1] + c[1])) / 3.0,
                    q[2] + (w * (a[2] + b[2] + c[2])) / 3.0,
                ];
                weight += w;
            }
            if weight <= 0.0 {
                return None;
            }
            let u = [q[0] / weight - p[0], q[1] / weight - p[1], q[2] / weight - p[2]];
            let n = self.vertex_normal(v);
            let along = dot(u, n);
            return Some([p[0] + 0.5 * (u[0] - along * n[0]), p[1] + 0.5 * (u[1] - along * n[1]), p[2] + 0.5 * (u[2] - along * n[2])]);
        }
        let line = self.line_neighbours(v);
        if line.len() != 2 {
            return None;
        }
        let (pa, pb) = (self.mesh.p(line[0]), self.mesh.p(line[1]));
        Some([
            p[0] + 0.5 * ((pa[0] + pb[0]) / 2.0 - p[0]),
            p[1] + 0.5 * ((pa[1] + pb[1]) / 2.0 - p[1]),
            p[2] + 0.5 * ((pa[2] + pb[2]) / 2.0 - p[2]),
        ])
    }

    fn relax(&mut self) {
        // The wanted positions read the mesh as it is before any move, so they are computed for all vertices at once (in vertex order, whatever the threads);
        // the moves are then applied one by one, each checked against the faces as the earlier moves left them.
        let moves: Vec<(u32, Vec3)> = (0..self.mesh.vertex_total() as u32)
            .into_par_iter()
            .filter_map(|v| {
                if !self.mesh.v_alive[v as usize] {
                    return None;
                }
                let kind = self.kind(v);
                if kind == Kind::Fixed {
                    return None;
                }
                let at = self.relaxed(v, kind)?;
                Some((v, if self.params.project && kind == Kind::Free { self.reference.closest(at).point } else { at }))
            })
            .collect();
        for (v, target) in moves {
            let mesh = &self.mesh;
            let flips = mesh.v_faces[v as usize].iter().any(|&f| {
                let [x, y, z] = mesh.corners(f);
                let pos = |c: u32| if c == v { target } else { mesh.p(c) };
                !acceptable([mesh.p(x), mesh.p(y), mesh.p(z)], [pos(x), pos(y), pos(z)])
            });
            if !flips {
                self.mesh.set_p(v, target);
            }
        }
    }

    fn edge_stats(&self) -> (EdgeStats, f64) {
        let mut lengths = Vec::new();
        let mut in_band = 0usize;
        let edges = self.all_edges();
        for &(a, b) in &edges {
            let l = dist(self.mesh.p(a), self.mesh.p(b));
            lengths.push(l);
            let target = self.edge_target(a, b);
            if l >= LOW * target * 0.999 && l <= HIGH * target * 1.001 {
                in_band += 1;
            }
        }
        let stats = summarize(lengths);
        (stats, if edges.is_empty() { 1.0 } else { in_band as f64 / edges.len() as f64 })
    }
}

/// Remesh a manifold, consistently wound, welded mesh; `on_progress` receives the share of the work done (0 to 1).
pub fn remesh(positions: &[f64], triangles: &[u32], params: &RemeshParams, on_progress: &mut dyn FnMut(f64)) -> Remeshed {
    let mut remesher = Remesher::new(positions, triangles, params);
    let triangles_before = remesher.mesh.live_faces;
    let steps = (params.iterations * 4 + 1) as f64;
    for i in 0..params.iterations {
        remesher.split_long();
        if remesher.exceeded {
            return Remeshed::TooLarge(remesher.mesh.live_faces);
        }
        on_progress((i * 4 + 1) as f64 / steps);
        remesher.collapse_short();
        on_progress((i * 4 + 2) as f64 / steps);
        remesher.flip_edges();
        on_progress((i * 4 + 3) as f64 / steps);
        remesher.relax();
        on_progress((i * 4 + 4) as f64 / steps);
    }
    for _ in 0..CLOSING_PASSES {
        if remesher.split_long() == 0 {
            break;
        }
        remesher.flip_edges();
    }
    if remesher.exceeded {
        return Remeshed::TooLarge(remesher.mesh.live_faces);
    }
    let (edge_length, fraction_in_band) = remesher.edge_stats();
    let report = RemeshReport {
        mode: if params.target_edge.is_none() { "adaptive" } else { "isotropic" },
        iterations: params.iterations,
        triangles_before,
        triangles_after: remesher.mesh.live_faces,
        splits: remesher.splits,
        collapses: remesher.collapses,
        flips: remesher.flips,
        edge_length,
        fraction_in_band,
        feature_edges: remesher.feature.len(),
    };
    let (out_positions, out_indices) = remesher.mesh.to_mesh();
    Remeshed::Done(out_positions, out_indices, report)
}
