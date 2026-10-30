//! Patch refinement of a filled hole (twin of `refinePatch` in `holeRefine.ts`, Liepa 2003 stage 3): triangles whose centroid is farther from every corner than the
//! local edge length are split at the centroid and the new edges relaxed toward Delaunay. The patch is a set of face ids; faces are only ever appended, so the
//! ascending order of the ids is both the order of the TypeScript `Set` (insertion order) and its sorted snapshot.

use crate::edit::EditMesh;
use crate::geom::{dist, dot, js_max, js_min, length, normal_of, Vec3};
use llull_jsmath::acos;
use std::collections::{BTreeSet, HashMap, VecDeque};

/// Hard cap on vertices a single patch may gain.
const MAX_NEW_VERTICES: usize = 4000;

fn corner_angle(mesh: &EditMesh, apex: u32, a: u32, b: u32) -> f64 {
    let (p, pa, pb) = (mesh.p(apex), mesh.p(a), mesh.p(b));
    let u = [pa[0] - p[0], pa[1] - p[1], pa[2] - p[2]];
    let v = [pb[0] - p[0], pb[1] - p[1], pb[2] - p[2]];
    let l = length(u) * length(v);
    if l > 0.0 {
        acos(js_max(-1.0, js_min(1.0, dot(u, v) / l)))
    } else {
        0.0
    }
}

/// Swap interior patch edges while the opposite angles sum above pi (Delaunay) and the swap keeps both normals on the old side.
fn relax_edges(mesh: &mut EditMesh, patch: &BTreeSet<u32>, edges: [(u32, u32); 3]) {
    let mut queue: VecDeque<(u32, u32)> = edges.into_iter().collect();
    let mut guard = 50 * (queue.len() + 10);
    let mut shared = Vec::new();
    let mut across = Vec::new();
    while !queue.is_empty() && guard > 0 {
        guard -= 1;
        let Some((a, b)) = queue.pop_front() else { break };
        mesh.faces_on_edge_into(a, b, &mut shared);
        if shared.len() != 2 || !shared.iter().all(|f| patch.contains(f)) {
            continue;
        }
        let (c, d) = (mesh.opposite(shared[0], a, b), mesh.opposite(shared[1], a, b));
        mesh.faces_on_edge_into(c, d, &mut across);
        if c == d || !across.is_empty() {
            continue;
        }
        if corner_angle(mesh, c, a, b) + corner_angle(mesh, d, a, b) <= std::f64::consts::PI + 1e-12 {
            continue;
        }
        let reference = mesh.face_normal(shared[0]);
        let (pa, pb, pc, pd) = (mesh.p(a), mesh.p(b), mesh.p(c), mesh.p(d));
        let flip_first = mesh.has_directed(shared[0], a, b);
        let n1 = if flip_first { normal_of(pa, pd, pc) } else { normal_of(pa, pc, pd) };
        let n2 = if flip_first { normal_of(pd, pb, pc) } else { normal_of(pc, pb, pd) };
        if dot(n1, reference) <= 0.0 || dot(n2, reference) <= 0.0 {
            continue;
        }
        mesh.flip(a, b);
        queue.extend([(a, c), (c, b), (b, d), (d, a)]);
    }
}

/// Insert centroids until the patch density matches the surrounding mesh (`sigma`: the local edge length of each vertex, `alpha`: Liepa's factor); returns the
/// inserted vertex ids.
pub fn refine_patch(mesh: &mut EditMesh, patch: &mut BTreeSet<u32>, sigma: &mut HashMap<u32, f64>, alpha: f64) -> Vec<u32> {
    let mut inserted: Vec<u32> = Vec::new();
    let mut pass = 0;
    while pass < 12 && inserted.len() < MAX_NEW_VERTICES {
        pass += 1;
        let mut changed = false;
        let snapshot: Vec<u32> = patch.iter().copied().collect();
        for face in snapshot {
            let [a, b, c] = mesh.corners(face);
            let (pa, pb, pc) = (mesh.p(a), mesh.p(b), mesh.p(c));
            let centre: Vec3 = [(pa[0] + pb[0] + pc[0]) / 3.0, (pa[1] + pb[1] + pc[1]) / 3.0, (pa[2] + pb[2] + pc[2]) / 3.0];
            // a vertex without a recorded length reads `undefined` in the TypeScript engine, which compares false: NaN does the same
            let of = |v: u32| sigma.get(&v).copied().unwrap_or(f64::NAN);
            let (sa, sb, sc) = (of(a), of(b), of(c));
            let sigma_centre = (sa + sb + sc) / 3.0;
            let needed = |p: Vec3, s: f64| alpha * dist(centre, p) > sigma_centre && alpha * dist(centre, p) > s;
            if !(needed(pa, sa) && needed(pb, sb) && needed(pc, sc)) {
                continue;
            }
            let v = mesh.add_vertex(centre);
            sigma.insert(v, sigma_centre);
            inserted.push(v);
            mesh.set_face(face, a, b, v);
            patch.insert(mesh.add_face(b, c, v));
            patch.insert(mesh.add_face(c, a, v));
            relax_edges(mesh, patch, [(a, b), (b, c), (c, a)]);
            changed = true;
            if inserted.len() >= MAX_NEW_VERTICES {
                break;
            }
        }
        if !changed {
            break;
        }
    }
    inserted
}
