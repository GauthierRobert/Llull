//! Is collapsing the edge `u`-`v` allowed? Link condition, no fold-over, and with a deviation bound the one-sided distance guard. The verdicts and
//! their priority are those of the TypeScript engine; the scratch buffers only avoid allocating on every attempt.

use crate::edit::EditMesh;
use crate::geom::{dot, length, normal_of, Vec3};
use crate::surface::SurfaceIndex;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    /// No face uses the edge any more: the candidate is dropped without being counted.
    Gone,
    Link,
    FoldOver,
    Deviation,
}

/// FxHash (the multiply-rotate hash of rustc) for the blame table: its keys are packed vertex pairs and need no protection against a hostile input.
#[derive(Default)]
pub struct EdgeHasher(u64);

impl Hasher for EdgeHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u64(u64::from(b));
        }
    }
    fn write_u64(&mut self, word: u64) {
        self.0 = (self.0.rotate_left(5) ^ word).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
}

type BlameTable = HashMap<u64, (u32, u32), BuildHasherDefault<EdgeHasher>>;

/// Packs the edge `a`-`b` as (low, high).
fn edge_key(a: u32, b: u32) -> u64 {
    (u64::from(a.min(b)) << 32) | u64::from(a.max(b))
}

#[cfg(test)]
thread_local! {
    /// Test switch (13.16.4): while set on a thread, `DeviationGuard` ignores its witnesses, blames and hints, so a test can run the same decimation with and without the caches.
    pub static CACHES_OFF: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// True when the caches are bypassed (only ever in a test).
#[cfg(test)]
fn caches_off() -> bool {
    CACHES_OFF.with(std::cell::Cell::get)
}

#[cfg(not(test))]
const fn caches_off() -> bool {
    false
}

/// A probe of the one-sided deviation guard: a point of the original surface (an original vertex or a triangle centre) that must stay within the bound of the surface
/// around the surviving vertex that owns it, with the **witness** that last proved it: the face (its stamp and its corners as they were) that was within the bound.
#[derive(Clone, Copy)]
pub struct Probe {
    pub p: Vec3,
    /// Identifies the probe (the blame table names it).
    pub id: u32,
    pub face: u32,
    pub stamp: u32,
    pub corners: [u32; 3],
}

impl Probe {
    pub fn new(p: Vec3, id: u32) -> Self {
        Self { p, id, face: NO_FACE, stamp: 0, corners: [NO_FACE; 3] }
    }
}

/// The state of the one-sided deviation guard: every original vertex and triangle centre is a probe owned by a surviving vertex, and a collapse may
/// not move the surface farther than `max_deviation` from the probes it touches or from the original surface.
///
/// Three caches make the guard cheaper without changing a verdict (13.16): a **witness** per probe (a face whose stamp is unchanged has the geometry it was measured
/// with, so the probe is still within the bound as long as that face is among the faces the test would use; the witness lives in the probe, so a vertex's probes are
/// read in order), a **blame** per refused edge, the probe that failed last time (an attempt on the same edge tests it first, and most are refused again), and a **hint** per
/// vertex, the original triangle that last answered one of its queries.
pub struct DeviationGuard {
    pub max_deviation: f64,
    pub owned: Vec<Vec<Probe>>,
    pub original: SurfaceIndex,
    /// Per face: counts the changes of its corners or of their positions.
    pub face_stamp: Vec<u32>,
    /// Per vertex: the original triangle that last answered a query of a collapse that keeps it ([`NO_FACE`] when none).
    pub hint: Vec<u32>,
    /// Per refused edge (packed low, high): the vertex and the probe that made the last attempt fail.
    pub blame: BlameTable,
}

/// "No face" in the witness and hint tables.
pub const NO_FACE: u32 = u32::MAX;

impl DeviationGuard {
    pub fn new(max_deviation: f64, owned: Vec<Vec<Probe>>, original: SurfaceIndex, faces: usize) -> Self {
        let hint = vec![NO_FACE; owned.len()];
        Self { max_deviation, owned, original, face_stamp: vec![0; faces], hint, blame: BlameTable::default() }
    }

    /// Call when `removed` was merged into another vertex: its edges (to `ring`, its neighbours) are gone, and so is what the blame table remembers about them.
    pub fn prune_blame(&mut self, removed: u32, ring: &[u32]) {
        for &x in ring {
            self.blame.remove(&edge_key(removed, x));
        }
    }

    /// Call when a collapse of `removed` into `kept` is applied: every face at either vertex changes (corner or position), so the witnesses naming it expire.
    pub fn touch(&mut self, mesh: &EditMesh, kept: u32, removed: u32) {
        for v in [kept, removed] {
            for &f in &mesh.v_faces[v as usize] {
                self.face_stamp[f as usize] = self.face_stamp[f as usize].wrapping_add(1);
            }
        }
    }
}

/// Buffers reused by every [`valid_collapse`] call.
#[derive(Default)]
pub struct Scratch {
    ring_u: Vec<u32>,
    ring_v: Vec<u32>,
    edge_faces: Vec<u32>,
    fan: Vec<[u32; 3]>,
    affected: Vec<u32>,
    faces: Vec<[Vec3; 3]>,
    face_ids: Vec<u32>,
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

/// Sorted lists `x` and `y` (no repeats) have the same common elements as the apexes of the edge faces (both sorted).
fn same_common_elements(x: &[u32], y: &[u32], apexes: &[u32]) -> bool {
    let (mut i, mut j, mut k) = (0, 0, 0);
    while i < x.len() && j < y.len() {
        if x[i] < y[j] {
            i += 1;
        } else if x[i] > y[j] {
            j += 1;
        } else {
            if apexes.get(k) != Some(&x[i]) {
                return false;
            }
            (i, j, k) = (i + 1, j + 1, k + 1);
        }
    }
    k == apexes.len()
}

/// Number of elements two sorted lists without repeats share.
fn common_count(x: &[u32], y: &[u32]) -> usize {
    x.iter().filter(|w| y.binary_search(w).is_ok()).count()
}

/// Whether collapsing `u`-`v` into `keep` (one of them) at `at` is valid. `area_floor` is the smallest area a surviving triangle may have.
pub fn valid_collapse(
    mesh: &EditMesh,
    area_floor: f64,
    guard: Option<&mut DeviationGuard>,
    scratch: &mut Scratch,
    (u, v): (u32, u32),
    keep: u32,
    at: Vec3,
) -> Verdict {
    let Scratch { ring_u, ring_v, edge_faces, fan, .. } = scratch;
    mesh.faces_on_edge_into(u, v, edge_faces);
    if edge_faces.is_empty() {
        return Verdict::Gone;
    }
    if edge_faces.len() > 2 {
        return Verdict::Link;
    }
    let boundary_u = mesh.ring_into(u, ring_u);
    let boundary_v = mesh.ring_into(v, ring_v);
    let mut apexes = [0u32; 2];
    for (apex, &f) in apexes.iter_mut().zip(edge_faces.iter()) {
        *apex = mesh.opposite(f, u, v);
    }
    let apexes = &mut apexes[..edge_faces.len()];
    apexes.sort_unstable();
    if !same_common_elements(ring_u, ring_v, apexes) {
        return Verdict::Link;
    }
    if edge_faces.len() == 2 && boundary_u && boundary_v {
        return Verdict::Link;
    }
    // |ring(u) union ring(v)| counts u and v themselves
    if edge_faces.len() == 2 && (ring_u.len() + ring_v.len() - common_count(ring_u, ring_v)) as i64 - 2 <= 3 {
        return Verdict::Link;
    }
    let removed = if keep == u { v } else { u };
    fan.clear();
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
            // a normal or an area that is not a number (overflow) is no proof that the triangle survives: refused as a fold-over
            let (dot_normals, area) = (dot(before, after), length(after) / 2.0);
            if dot_normals <= 0.0 || dot_normals.is_nan() || area <= area_floor || area.is_nan() {
                return Verdict::FoldOver;
            }
            fan.push([swap(x), swap(y), swap(z)]);
        }
    }
    match guard {
        Some(guard) => deviation_verdict(mesh, guard, (u, v), (keep, at), scratch),
        None => Verdict::Ok,
    }
}

/// The probe tests of one attempt: the faces of the vertex being tested after the collapse are gathered once, when a probe has no valid witness.
struct Check<'a, F: Fn(u32) -> Vec3> {
    mesh: &'a EditMesh,
    edge: (u32, u32),
    fan: &'a [[u32; 3]],
    limit: f64,
    place: &'a F,
    face_stamp: &'a [u32],
    faces: &'a mut Vec<[Vec3; 3]>,
    face_ids: &'a mut Vec<u32>,
    /// The vertex whose faces `faces` holds ([`NO_FACE`] when none).
    loaded: u32,
    /// False in a test that bypasses the witnesses.
    witnesses: bool,
}

impl<F: Fn(u32) -> Vec3> Check<'_, F> {
    /// True when `probe`, owned by `o`, is within the bound of a face at `o` after the collapse.
    fn holds(&mut self, o: u32, probe: &mut Probe) -> bool {
        let (u, v) = self.edge;
        if self.witnesses
            && probe.face != NO_FACE
            && self.face_stamp[probe.face as usize] == probe.stamp
            && probe.corners.contains(&o)
            && !probe.corners.contains(&u)
            && !probe.corners.contains(&v)
        {
            return true;
        }
        if self.loaded != o {
            self.loaded = o;
            self.faces.clear();
            self.face_ids.clear();
            for &f in &self.mesh.v_faces[o as usize] {
                let [x, y, z] = self.mesh.corners(f);
                if x == u || x == v || y == u || y == v || z == u || z == v {
                    continue;
                }
                self.faces.push([self.mesh.p(x), self.mesh.p(y), self.mesh.p(z)]);
                self.face_ids.push(f);
            }
            for triple in self.fan {
                if triple.contains(&o) {
                    self.faces.push([(self.place)(triple[0]), (self.place)(triple[1]), (self.place)(triple[2])]);
                    self.face_ids.push(NO_FACE);
                }
            }
        }
        // the nearest triangle is farther than the bound exactly when none is within it (a NaN distance counts as within, as in the TypeScript min)
        let (p, limit) = (probe.p, self.limit);
        let found = self.faces.iter().position(|[a, b, c]| {
            let d = point_triangle_sq(p, *a, *b, *c);
            d <= limit || d.is_nan()
        });
        match found {
            Some(i) => {
                let id = self.face_ids[i];
                if id != NO_FACE && self.witnesses {
                    *probe = Probe { face: id, stamp: self.face_stamp[id as usize], corners: self.mesh.corners(id), ..*probe };
                }
                true
            }
            None => self.faces.is_empty() && limit.is_infinite() && limit > 0.0,
        }
    }
}

fn deviation_verdict(
    mesh: &EditMesh,
    guard: &mut DeviationGuard,
    (u, v): (u32, u32),
    (keep, at): (u32, Vec3),
    scratch: &mut Scratch,
) -> Verdict {
    let Scratch { ring_u, ring_v, fan, affected, faces, face_ids, .. } = scratch;
    let removed = if keep == u { v } else { u };
    affected.clear();
    affected.push(keep);
    for &w in ring_u.iter().chain(ring_v.iter()) {
        if w != removed && !affected.contains(&w) {
            affected.push(w);
        }
    }
    let max_deviation = guard.max_deviation;
    let limit = max_deviation * max_deviation;
    let place = |c: u32| if c == keep { at } else { mesh.p(c) };
    // The three tests below fail independently of one another, so the order only decides how soon a refusal is found: the probes first (a probe
    // is satisfied by the first triangle within the bound), the queries on the original surface after.
    let DeviationGuard { owned, original, face_stamp, hint, blame, .. } = guard;
    let edge = edge_key(u, v);
    let off = caches_off();
    let mut check = Check { mesh, edge: (u, v), fan, limit, place: &place, face_stamp, faces, face_ids, loaded: NO_FACE, witnesses: !off };
    // the probes the removed vertex owned are the survivor's now; they are tested with its own
    let mut inherited = std::mem::take(&mut owned[removed as usize]);
    let mut nothing: Vec<Probe> = Vec::new();
    let failed: Option<(u32, u32)> = 'scan: {
        // the probe that failed the last attempt on this edge goes first (only one still owned by an affected vertex counts)
        if let Some(&(o, id)) = blame.get(&edge).filter(|_| !off) {
            if affected.contains(&o) {
                let extra: &mut [Probe] = if o == keep { &mut inherited } else { &mut nothing };
                if let Some(probe) = owned[o as usize].iter_mut().chain(extra.iter_mut()).find(|probe| probe.id == id) {
                    if !check.holds(o, probe) {
                        break 'scan Some((o, id));
                    }
                }
            }
        }
        for &o in affected.iter() {
            let extra: &mut [Probe] = if o == keep { &mut inherited } else { &mut nothing };
            for probe in owned[o as usize].iter_mut().chain(extra.iter_mut()) {
                if !check.holds(o, probe) {
                    break 'scan Some((o, probe.id));
                }
            }
        }
        None
    };
    owned[removed as usize] = inherited;
    if let Some(blamed) = failed {
        if !off {
            blame.insert(edge, blamed);
        }
        return Verdict::Deviation;
    }
    // the queries on the original surface start from the triangle that answered the last one of this vertex
    let mut last = if off { NO_FACE } else { hint[keep as usize] };
    let mut verdict = Verdict::Ok;
    let mut query = |p: Vec3| match original.within(p, max_deviation, last) {
        Some(face) => {
            if face >= 0 {
                last = face as u32;
            }
            true
        }
        None => false,
    };
    if !query(at) {
        verdict = Verdict::Deviation;
    } else {
        for &[x, y, z] in fan.iter() {
            let (pa, pb, pc) = (place(x), place(y), place(z));
            let centre = [(pa[0] + pb[0] + pc[0]) / 3.0, (pa[1] + pb[1] + pc[1]) / 3.0, (pa[2] + pb[2] + pc[2]) / 3.0];
            if !query(centre) {
                verdict = Verdict::Deviation;
                break;
            }
        }
    }
    if !off {
        hint[keep as usize] = last;
    }
    verdict
}

#[cfg(test)]
mod tests {
    use super::{valid_collapse, DeviationGuard, Probe, Scratch, Verdict};
    use crate::edit::EditMesh;
    use crate::surface::SurfaceIndex;

    fn verdict(mesh: &EditMesh, (u, v): (u32, u32), keep: u32, at: [f64; 3], guard: Option<&mut DeviationGuard>) -> Verdict {
        valid_collapse(mesh, 1e-12, guard, &mut Scratch::default(), (u, v), keep, at)
    }

    /// A fan of `n` triangles around vertex 0 (an open disc) when `closed` is false; vertices 1..=n on the unit circle.
    fn disc(n: usize, closed: bool) -> EditMesh {
        let mut positions = vec![0.0, 0.0, 0.0];
        for k in 0..n {
            let angle = k as f64 * std::f64::consts::TAU / n as f64;
            positions.extend([angle.cos(), angle.sin(), 0.0]);
        }
        let faces = if closed { n } else { n - 1 };
        let triangles: Vec<u32> = (0..faces).flat_map(|k| [0, 1 + k as u32, 1 + ((k + 1) % n) as u32]).collect();
        EditMesh::new(&positions, &triangles)
    }

    #[test]
    fn an_edge_without_faces_is_gone_and_one_with_three_faces_fails_the_link_condition() {
        let book =
            EditMesh::new(&[0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 1.0, 0.0], &[0, 1, 2, 1, 0, 3, 0, 1, 4]);
        assert!(verdict(&book, (0, 1), 0, [0.0; 3], None) == Verdict::Link);
        assert!(verdict(&book, (2, 3), 2, [0.0; 3], None) == Verdict::Gone);
    }

    #[test]
    fn the_link_condition_refuses_a_tetrahedron_and_a_bridge_between_two_boundary_vertices() {
        let tetrahedron =
            EditMesh::new(&[1.0, 1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0, -1.0], &[0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]);
        assert_eq!(verdict(&tetrahedron, (0, 1), 0, [0.0; 3], None), Verdict::Link);
        // a strip of two cells: the middle edge 1-4 is interior but both its ends are on the boundary
        let strip = EditMesh::new(
            &[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 2.0, 1.0, 0.0],
            &[0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4],
        );
        assert_eq!(verdict(&strip, (1, 4), 1, [1.0, 0.5, 0.0], None), Verdict::Link);
        // the spoke of a fan joins an interior vertex to a boundary one
        assert_eq!(verdict(&disc(8, true), (0, 1), 1, [1.0, 0.0, 0.0], None), Verdict::Ok);
    }

    #[test]
    fn a_collapse_that_turns_a_neighbour_over_is_a_fold_over() {
        let wheel = disc(12, true);
        // sending the survivor across the disc flips the triangles on the near side
        assert_eq!(verdict(&wheel, (0, 1), 1, [-5.0, 0.0, 0.0], None), Verdict::FoldOver);
        assert_eq!(verdict(&wheel, (0, 1), 1, [0.5, 0.0, 0.0], None), Verdict::Ok);
    }

    #[test]
    fn the_deviation_guard_refuses_a_move_off_the_original_surface_and_accepts_one_on_it() {
        let wheel = disc(12, true);
        let original = SurfaceIndex::new(&wheel.pos, &wheel.faces);
        let owned: Vec<Vec<Probe>> = (0..13).map(|v| vec![Probe::new(wheel.p(v), v)]).collect();
        let mut guard = DeviationGuard::new(0.05, owned, original, wheel.f_alive.len());
        assert_eq!(verdict(&wheel, (0, 1), 1, [1.0, 0.0, 0.0], Some(&mut guard)), Verdict::Ok);
        // lifting the survivor off the plane moves the surface away from the probes
        assert_eq!(verdict(&wheel, (0, 1), 1, [1.0, 0.0, 0.3], Some(&mut guard)), Verdict::Deviation);
    }
}
