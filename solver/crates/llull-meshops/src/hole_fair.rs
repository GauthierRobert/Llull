//! Fairing of the inserted vertices of a patch (twin of `fairVertices` in `holeRefine.ts`, Liepa 2003 stage 4): the vertices move to solve the membrane
//! (K x = 0, `Tangent`) or thin-plate (K M^-1 K x = 0, `Curvature`) equation with every other vertex fixed (K the cotangent stiffness matrix, M the lumped
//! mass), by conjugate gradients to a relative residual of 1e-10. The TypeScript code gathers its vertices, faces and edge weights through JavaScript `Set`s and
//! `Map`s, so the sums over them run in insertion order; `Ordered` keeps that order, and every reduction below is the same left-to-right fold.

use crate::edit::EditMesh;
use crate::geom::{dot, js_max, length, normal_of, Vec3};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fairing {
    None,
    Tangent,
    Curvature,
}

/// `new Set(...)`: values once, iterated in insertion order.
#[derive(Default)]
struct Ordered {
    order: Vec<u32>,
    seen: HashSet<u32>,
}

impl Ordered {
    fn insert(&mut self, v: u32) {
        if self.seen.insert(v) {
            self.order.push(v);
        }
    }
}

struct System {
    local: HashMap<u32, usize>,
    size: usize,
    neighbours: Vec<Vec<usize>>,
    /// Cotangent edge weights, parallel to the neighbour lists.
    weights: Vec<Vec<f64>>,
    /// Lumped mass (one third of the incident face areas) per local vertex.
    mass: Vec<f64>,
    rows: Vec<usize>,
    free_local: Vec<usize>,
    thin_plate: bool,
}

fn cot(apex: Vec3, a: Vec3, b: Vec3) -> f64 {
    let u = [a[0] - apex[0], a[1] - apex[1], a[2] - apex[2]];
    let v = [b[0] - apex[0], b[1] - apex[1], b[2] - apex[2]];
    let area2 = length(normal_of(apex, a, b));
    if area2 > 1e-300 {
        dot(u, v) / area2
    } else {
        0.0
    }
}

/// The key `holeRefine.ts` gives the edge between `a` and `b`.
fn edge_key(a: u32, b: u32) -> u64 {
    u64::from(a.min(b)) * 67_108_864 + u64::from(a.max(b))
}

fn build_system(mesh: &EditMesh, free: &[u32], thin_plate: bool) -> System {
    let mut ring = Vec::new();
    let mut involved = Ordered::default();
    for &v in free {
        involved.insert(v);
    }
    for &v in free {
        mesh.ring_into(v, &mut ring);
        ring.iter().for_each(|&w| involved.insert(w));
    }
    let mut everything = Ordered::default();
    for &v in &involved.order {
        everything.insert(v);
    }
    for &v in &involved.order {
        mesh.ring_into(v, &mut ring);
        ring.iter().for_each(|&w| everything.insert(w));
    }
    let mut ids = everything.order;
    ids.sort_unstable();
    let local: HashMap<u32, usize> = ids.iter().enumerate().map(|(k, &v)| (v, k)).collect();
    let mut edge_weight: HashMap<u64, f64> = HashMap::new();
    let mut mass: HashMap<u32, f64> = HashMap::new();
    let mut faces = Ordered::default();
    for &v in &involved.order {
        mesh.v_faces[v as usize].iter().for_each(|&f| faces.insert(f));
    }
    for &f in &faces.order {
        let corners = mesh.corners(f);
        let points = corners.map(|c| mesh.p(c));
        let area = length(normal_of(points[0], points[1], points[2])) / 2.0;
        for k in 0..3 {
            let (a, b) = (corners[(k + 1) % 3], corners[(k + 2) % 3]);
            let weight = cot(points[k], points[(k + 1) % 3], points[(k + 2) % 3]) / 2.0;
            let entry = edge_weight.entry(edge_key(a, b)).or_insert(0.0);
            *entry += weight;
            *mass.entry(corners[k]).or_insert(0.0) += area / 3.0;
        }
    }
    let rings: Vec<Vec<u32>> = ids
        .iter()
        .map(|&v| {
            if involved.seen.contains(&v) {
                mesh.ring_into(v, &mut ring);
                ring.clone()
            } else {
                Vec::new()
            }
        })
        .collect();
    System {
        size: ids.len(),
        neighbours: rings.iter().map(|ring| ring.iter().map(|w| local[w]).collect()).collect(),
        weights: rings
            .iter()
            .zip(&ids)
            .map(|(ring, &id)| ring.iter().map(|&w| edge_weight.get(&edge_key(w, id)).copied().unwrap_or(0.0)).collect())
            .collect(),
        mass: ids.iter().map(|v| js_max(mass.get(v).copied().unwrap_or(0.0), 1e-300)).collect(),
        rows: involved.order.iter().map(|v| local[v]).collect(),
        free_local: free.iter().map(|v| local[v]).collect(),
        local,
        thin_plate,
    }
}

fn umbrella(system: &System, x: &[f64], rows: &[usize], scaled: bool) -> Vec<f64> {
    let mut out = vec![0.0; x.len()];
    for &k in rows {
        let mut sum = 0.0;
        for (n, &w) in system.neighbours[k].iter().enumerate() {
            sum += system.weights[k][n] * (x[k] - x[w]);
        }
        out[k] = if scaled { sum / system.mass[k] } else { sum };
    }
    out
}

/// The fairing operator on a full-length vector, evaluated on the free rows only.
fn operator(system: &System, x: &[f64]) -> Vec<f64> {
    let first = umbrella(system, x, &system.rows, system.thin_plate);
    if system.thin_plate {
        umbrella(system, &first, &system.free_local, false)
    } else {
        first
    }
}

fn sum_of_squares(values: &[f64]) -> f64 {
    values.iter().fold(0.0, |s, v| s + v * v)
}

/// Solve the fairing equation for the vertices `free` (all others fixed) and move them.
pub fn fair_vertices(mesh: &mut EditMesh, free: &[u32], fairing: Fairing) {
    if free.is_empty() || fairing == Fairing::None {
        return;
    }
    let system = build_system(mesh, free, fairing == Fairing::Curvature);
    let mut columns: Vec<Vec<f64>> = Vec::with_capacity(3);
    let free_set: HashSet<u32> = free.iter().copied().collect();
    let mut ids: Vec<(u32, usize)> = system.local.iter().map(|(&v, &k)| (v, k)).collect();
    ids.sort_unstable_by_key(|&(_, k)| k);
    for axis in 0..3 {
        let mut fixed_only = vec![0.0; system.size];
        for &(v, k) in &ids {
            fixed_only[k] = if free_set.contains(&v) { 0.0 } else { mesh.pos[v as usize * 3 + axis] };
        }
        let rhs_full = operator(&system, &fixed_only);
        let b: Vec<f64> = system.free_local.iter().map(|&k| -rhs_full[k]).collect();
        let norm = length_of(&b);
        let apply = |values: &[f64]| -> Vec<f64> {
            let mut x = vec![0.0; system.size];
            for (i, &k) in system.free_local.iter().enumerate() {
                x[k] = values[i];
            }
            let y = operator(&system, &x);
            system.free_local.iter().map(|&k| y[k]).collect()
        };
        let mut x: Vec<f64> = free.iter().map(|&v| mesh.pos[v as usize * 3 + axis]).collect();
        let mut r: Vec<f64> = apply(&x).iter().enumerate().map(|(i, value)| b[i] - value).collect();
        let mut p = r.clone();
        let mut rr = sum_of_squares(&r);
        let mut count = 0usize;
        let limit = 20 * free.len() + 500;
        while rr.sqrt() > 1e-10 * js_max(norm, 1e-300) && count < limit {
            let ap = apply(&p);
            let denominator = p.iter().enumerate().fold(0.0, |s, (i, v)| s + v * ap[i]);
            if denominator.is_nan() || denominator <= 0.0 {
                break;
            }
            let alpha = rr / denominator;
            x = x.iter().enumerate().map(|(i, v)| v + alpha * p[i]).collect();
            r = r.iter().enumerate().map(|(i, v)| v - alpha * ap[i]).collect();
            let next = sum_of_squares(&r);
            p = p.iter().enumerate().map(|(i, v)| r[i] + (next / rr) * v).collect();
            rr = next;
            count += 1;
        }
        columns.push(x);
    }
    for (i, &v) in free.iter().enumerate() {
        mesh.set_p(v, [columns[0][i], columns[1][i], columns[2][i]]);
    }
}

/// V8 `Math.hypot(...values)`.
fn length_of(values: &[f64]) -> f64 {
    llull_jsmath::hypot(values)
}
