//! Penalty node-to-segment contact with Coulomb friction (RS1 RS-8c). Sources: LS-DYNA R14 Theory Manual ([E2]) Ch. 29, read from the
//! rendered pages (PHY-19 TECHNICAL_SPEC §13.7):
//! - Segments: the exterior faces of the solid elements of the contact's parts (bilinear quads for hex8, triangles for tet4), oriented
//!   outward. Candidate segments of a slave node come from a `llull-bvh` box tree rebuilt every cycle (the manual re-sorts buckets every
//!   10–15 cycles, §29.12; every cycle is the conservative choice).
//! - Contact point: `∂r/∂ξ · (t − r) = ∂r/∂η · (t − r) = 0` (Eqs. 29.10–29.11): 3 least-squares (Gauss–Newton) iterations from (0, 0),
//!   then up to 10 Newton iterations (Eqs. 29.12–29.13). The printed Hessian term `r·r,ξη` is used here as the exact `(r − t)·r,ξη`;
//!   the printed least-squares right-hand side `r − t` is applied with the descent sign. Parametric tolerance MAXPAR 1.025 ([E3]).
//! - Penetration `l = n·(t − r(ξc, ηc)) < 0` (Eq. 29.14), slave force `f_s = −l k n` (Eq. 29.16), master nodes `−φ_i f_s` (Eq. 29.17),
//!   solid segment stiffness `k = f_si K A² / V` (Eq. 29.18) with `f_si` = SLSFAC (default 0.1); the stiffness used is the minimum of the
//!   master segment's and the slave node's (PENOPT default, [E3] *CONTROL_CONTACT).
//! - Two surfaces: checked both ways (symmetric, *CONTACT Remark 4), or one way, slave nodes against master segments (node-to-surface,
//!   type 5: "the same subroutines … called once, not twice", p. 29-15). Self contact: one surface against itself; a node never contacts a
//!   segment of an element it belongs to (the manual excludes segments that contain the node, §29.12.1; excluding the node's own elements
//!   is llull's stricter rule, which also removes the opposite face of a one-element-thick wall).
//! - Friction (Eqs. 29.25–29.31): `F_y = μ|f_n|`, `Δe = r^{n+1}(ξc^{n+1}) − r^{n+1}(ξc^n)`, trial `f* = f^n − kΔe`, return to `F_y f*/|f*|`
//!   when `|f*| > F_y`, `μ = μ_d + (μ_s − μ_d) e^{−c|v|}` with `v = |Δe|/Δt`. Projecting `f^n` and `Δe` onto the current tangent plane is
//!   llull's choice (the manual does not say).
//! - Penetrations deeper than half the master element's thickness `V/A` are ignored (llull's guard against picking the far face of a body);
//!   penetrations shallower than 1e-9 of it are round-off (a node lying on a coplanar face of the other body). The segment a node was in
//!   contact with keeps it while still penetrated; otherwise the shallowest penetration wins (llull's selection rule, measured necessary:
//!   without it the nodes on the edges of two colliding bars picked the coplanar side faces and the bars passed through each other).
//! - Deterministic: passes, slave nodes and candidates run in ascending order; forces are added in that order.

use crate::model::{Contact, ContactKind, Model};
use llull_bvh::{Aabb, Bvh};

/// MAXPAR: largest accepted |parametric coordinate| (LS-DYNA *CONTACT default 1.025).
const MAXPAR: f64 = 1.025;

/// A penetration shallower than this fraction of the segment depth is round-off (a node on a coplanar face), not contact.
const ROUND_OFF: f64 = 1e-9;

#[derive(Debug, Clone)]
struct Segment {
    nodes: Vec<usize>,
    element: usize,
    part: u32,
    stiffness: f64,
    depth: f64,
}

#[derive(Debug, Clone, Copy, Default)]
struct SlaveState {
    previous: Option<(usize, f64, f64)>,
    tangential: [f64; 3],
}

#[derive(Debug, Clone)]
struct Pass {
    slaves: Vec<usize>,
    slave_stiffness: Vec<f64>,
    masters: Vec<usize>,
    self_contact: bool,
    contact: usize,
    state: Vec<SlaveState>,
}

/// The contact set of a model and its friction history.
#[derive(Debug, Clone)]
pub struct Contacts {
    segments: Vec<Segment>,
    element_nodes: Vec<Vec<usize>>,
    passes: Vec<Pass>,
    definitions: Vec<Contact>,
}

const HEX_FACES: [[usize; 4]; 6] = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
const TET_FACES: [[usize; 3]; 4] = [[0, 2, 1], [1, 2, 3], [0, 3, 2], [0, 1, 3]];

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}
fn point(x: &[f64], node: usize) -> [f64; 3] {
    [x[3 * node], x[3 * node + 1], x[3 * node + 2]]
}

/// Shape functions of a segment at (ξ, η): bilinear quad (nodes at (−,−), (+,−), (+,+), (−,+)) or linear triangle (1 − ξ − η, ξ, η).
fn shape(count: usize, xi: f64, eta: f64) -> Vec<f64> {
    if count == 3 {
        return vec![1.0 - xi - eta, xi, eta];
    }
    let corners = [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)];
    corners.iter().map(|(a, b)| 0.25 * (1.0 + a * xi) * (1.0 + b * eta)).collect()
}

fn evaluate(nodes: &[usize], x: &[f64], xi: f64, eta: f64) -> [f64; 3] {
    let weights = shape(nodes.len(), xi, eta);
    let mut r = [0.0; 3];
    for (weight, &node) in weights.iter().zip(nodes) {
        let p = point(x, node);
        for i in 0..3 {
            r[i] += weight * p[i];
        }
    }
    r
}

/// Closest point of `t` on the (bilinear) segment: parametric coordinates, the point and the unit outward normal there.
fn project(nodes: &[usize], x: &[f64], t: [f64; 3]) -> Option<(f64, f64, [f64; 3], [f64; 3])> {
    let p: Vec<[f64; 3]> = nodes.iter().map(|&node| point(x, node)).collect();
    if nodes.len() == 3 {
        let (e1, e2) = (sub(p[1], p[0]), sub(p[2], p[0]));
        let n = cross(e1, e2);
        let length = norm(n);
        if length == 0.0 {
            return None;
        }
        let normal = n.map(|value| value / length);
        let d = sub(t, p[0]);
        let (a11, a12, a22) = (dot(e1, e1), dot(e1, e2), dot(e2, e2));
        let (b1, b2) = (dot(e1, d), dot(e2, d));
        let det = a11 * a22 - a12 * a12;
        let xi = (b1 * a22 - b2 * a12) / det;
        let eta = (a11 * b2 - a12 * b1) / det;
        return Some((xi, eta, evaluate(nodes, x, xi, eta), normal));
    }
    let signs = [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)];
    let derivatives = |xi: f64, eta: f64| {
        let mut r_xi = [0.0; 3];
        let mut r_eta = [0.0; 3];
        let mut r_xe = [0.0; 3];
        for (k, (a, b)) in signs.iter().enumerate() {
            for i in 0..3 {
                r_xi[i] += 0.25 * a * (1.0 + b * eta) * p[k][i];
                r_eta[i] += 0.25 * b * (1.0 + a * xi) * p[k][i];
                r_xe[i] += 0.25 * a * b * p[k][i];
            }
        }
        (r_xi, r_eta, r_xe)
    };
    let (mut xi, mut eta) = (0.0, 0.0);
    for iteration in 0..13 {
        let r = evaluate(nodes, x, xi, eta);
        let (r_xi, r_eta, r_xe) = derivatives(xi, eta);
        let gap = sub(r, t);
        let coupling = if iteration < 3 { 0.0 } else { dot(gap, r_xe) };
        let (h11, h12, h22) = (dot(r_xi, r_xi), dot(r_xi, r_eta) + coupling, dot(r_eta, r_eta));
        let (g1, g2) = (dot(r_xi, gap), dot(r_eta, gap));
        let det = h11 * h22 - h12 * h12;
        if det == 0.0 || !det.is_finite() {
            return None;
        }
        let d_xi = -(h22 * g1 - h12 * g2) / det;
        let d_eta = -(h11 * g2 - h12 * g1) / det;
        xi += d_xi;
        eta += d_eta;
        if iteration >= 3 && d_xi.abs() + d_eta.abs() < 1e-12 {
            break;
        }
    }
    let (r_xi, r_eta, _) = derivatives(xi, eta);
    let n = cross(r_xi, r_eta);
    let length = norm(n);
    if length == 0.0 || !xi.is_finite() || !eta.is_finite() {
        return None;
    }
    Some((xi, eta, evaluate(nodes, x, xi, eta), n.map(|value| value / length)))
}

fn inside(count: usize, xi: f64, eta: f64) -> bool {
    if count == 3 {
        let slack = MAXPAR - 1.0;
        return xi >= -slack && eta >= -slack && xi + eta <= 1.0 + slack;
    }
    xi.abs() <= MAXPAR && eta.abs() <= MAXPAR
}

fn area(nodes: &[usize], x: &[f64]) -> f64 {
    let p: Vec<[f64; 3]> = nodes.iter().map(|&node| point(x, node)).collect();
    if nodes.len() == 3 {
        return 0.5 * norm(cross(sub(p[1], p[0]), sub(p[2], p[0])));
    }
    0.5 * norm(cross(sub(p[2], p[0]), sub(p[3], p[1])))
}

impl Contacts {
    /// The contact set of `model` (None without contacts). `volumes` are the element volumes at `x`.
    pub fn new(model: &Model, x: &[f64], volumes: &[f64]) -> Option<Contacts> {
        if model.contacts.is_empty() {
            return None;
        }
        let element_nodes: Vec<Vec<usize>> =
            model.hex8.chunks_exact(8).chain(model.tet4.chunks_exact(4)).map(|nodes| nodes.iter().map(|&n| n as usize).collect()).collect();
        let mut faces: std::collections::BTreeMap<Vec<usize>, (Vec<usize>, usize, u32)> = std::collections::BTreeMap::new();
        let mut counts: std::collections::BTreeMap<Vec<usize>, usize> = std::collections::BTreeMap::new();
        for (element, nodes) in element_nodes.iter().enumerate() {
            let part = model.element_part.get(element).copied().unwrap_or(0);
            let local: Vec<Vec<usize>> = if nodes.len() == 8 {
                HEX_FACES.iter().map(|face| face.iter().map(|&k| nodes[k]).collect()).collect()
            } else {
                TET_FACES.iter().map(|face| face.iter().map(|&k| nodes[k]).collect()).collect()
            };
            for face in local {
                let mut key = face.clone();
                key.sort_unstable();
                *counts.entry(key.clone()).or_insert(0) += 1;
                faces.insert(key, (face, element, part));
            }
        }
        let segments: Vec<Segment> = faces
            .into_iter()
            .filter(|(key, _)| counts.get(key) == Some(&1))
            .map(|(_, (nodes, element, part))| {
                let material = &model.materials[model.element_material[element] as usize];
                let a = area(&nodes, x);
                let v = volumes[element];
                Segment { stiffness: material.bulk() * a * a / v, depth: 0.5 * v / a, nodes, element, part }
            })
            .collect();
        let mut passes = Vec::new();
        for (index, contact) in model.contacts.iter().enumerate() {
            let of = |parts: &[u32]| -> Vec<usize> { (0..segments.len()).filter(|&s| parts.contains(&segments[s].part)).collect() };
            let pairs: Vec<(Vec<usize>, Vec<usize>, bool)> = match &contact.kind {
                ContactKind::SurfaceToSurface { a, b } => vec![(of(a), of(b), false), (of(b), of(a), false)],
                ContactKind::NodesToSurface { slave, master } => vec![(of(slave), of(master), false)],
                ContactKind::SelfContact { parts } => vec![(of(parts), of(parts), true)],
            };
            for (slave_segments, masters, self_contact) in pairs {
                let mut stiffness: std::collections::BTreeMap<usize, f64> = std::collections::BTreeMap::new();
                for &s in &slave_segments {
                    for &node in &segments[s].nodes {
                        let k = stiffness.entry(node).or_insert(f64::INFINITY);
                        *k = k.min(contact.penalty_scale * segments[s].stiffness);
                    }
                }
                let slaves: Vec<usize> = stiffness.keys().copied().collect();
                let slave_stiffness = stiffness.values().copied().collect();
                let state = vec![SlaveState::default(); slaves.len()];
                passes.push(Pass { slaves, slave_stiffness, masters, self_contact, contact: index, state });
            }
        }
        Some(Contacts { segments, element_nodes, passes, definitions: model.contacts.clone() })
    }

    /// Contact forces (3 per node) at positions `x`, for a step of length `dt` (friction slip rate).
    pub fn forces(&mut self, x: &[f64], dt: f64) -> Vec<f64> {
        let mut forces = vec![0.0; x.len()];
        for pass in &mut self.passes {
            let definition = &self.definitions[pass.contact];
            let boxes: Vec<Aabb> = pass
                .masters
                .iter()
                .map(|&s| {
                    let mut low = [f64::INFINITY; 3];
                    let mut high = [f64::NEG_INFINITY; 3];
                    for &node in &self.segments[s].nodes {
                        let p = point(x, node);
                        for i in 0..3 {
                            low[i] = low[i].min(p[i]);
                            high[i] = high[i].max(p[i]);
                        }
                    }
                    Aabb { low, high }
                })
                .collect();
            let Some(tree) = Bvh::build(&boxes) else { continue };
            let reach = pass.masters.iter().map(|&s| self.segments[s].depth).fold(0.0, f64::max);
            for (position, &node) in pass.slaves.iter().enumerate() {
                let t = point(x, node);
                let mut best: Option<(usize, f64, f64, [f64; 3], f64)> = None;
                for candidate in tree.overlapping(&t, reach) {
                    let s = pass.masters[candidate];
                    let segment = &self.segments[s];
                    if segment.nodes.contains(&node) || (pass.self_contact && self.element_nodes[segment.element].contains(&node)) {
                        continue;
                    }
                    let Some((xi, eta, r, n)) = project(&segment.nodes, x, t) else { continue };
                    if !inside(segment.nodes.len(), xi, eta) {
                        continue;
                    }
                    let l = dot(n, sub(t, r));
                    if !(l < -ROUND_OFF * segment.depth && l > -segment.depth) {
                        continue;
                    }
                    // The segment the node was in contact with last cycle keeps it while still penetrated (LS-DYNA stores the
                    // contact segment every step, §29.6); otherwise the shallowest penetration wins.
                    let kept = pass.state[position].previous.is_some_and(|(previous, _, _)| previous == s);
                    let current_kept = best.is_some_and(|(b, _, _, _, _)| pass.state[position].previous.is_some_and(|(p, _, _)| p == b));
                    if kept || (!current_kept && best.is_none_or(|(_, _, _, _, b)| l.abs() < b.abs())) {
                        best = Some((s, xi, eta, n, l));
                    }
                }
                let state = &mut pass.state[position];
                let Some((s, xi, eta, n, l)) = best else {
                    *state = SlaveState::default();
                    continue;
                };
                let segment = &self.segments[s];
                let k = (definition.penalty_scale * segment.stiffness).min(pass.slave_stiffness[position]);
                let normal_force = -l * k;
                let mut total: [f64; 3] = n.map(|component| normal_force * component);
                let friction = definition.friction;
                if friction.static_coefficient > 0.0 || friction.dynamic_coefficient > 0.0 {
                    let current = evaluate(&segment.nodes, x, xi, eta);
                    let slip = match state.previous {
                        Some((previous, p_xi, p_eta)) => sub(current, evaluate(&self.segments[previous].nodes, x, p_xi, p_eta)),
                        None => [0.0; 3],
                    };
                    let tangent = |v: [f64; 3]| {
                        let along = dot(v, n);
                        [v[0] - along * n[0], v[1] - along * n[1], v[2] - along * n[2]]
                    };
                    let slip = tangent(slip);
                    let old = tangent(state.tangential);
                    let trial = [old[0] - k * slip[0], old[1] - k * slip[1], old[2] - k * slip[2]];
                    let speed = if dt > 0.0 { norm(slip) / dt } else { 0.0 };
                    let mu = friction.dynamic_coefficient
                        + (friction.static_coefficient - friction.dynamic_coefficient) * (-friction.decay * speed).exp();
                    let limit = mu * normal_force.abs();
                    let size = norm(trial);
                    let tangential = if size > limit && size > 0.0 { trial.map(|c| limit * c / size) } else { trial };
                    state.tangential = tangential;
                    for i in 0..3 {
                        total[i] += tangential[i];
                    }
                }
                state.previous = Some((s, xi, eta));
                for i in 0..3 {
                    forces[3 * node + i] += total[i];
                }
                for (weight, &master) in shape(segment.nodes.len(), xi, eta).iter().zip(&segment.nodes) {
                    for i in 0..3 {
                        forces[3 * master + i] -= weight * total[i];
                    }
                }
            }
        }
        forces
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_onto_a_warped_quad_and_a_triangle() {
        // A unit square lifted at node 2: the closest point of (0.3, 0.6, 1) satisfies the orthogonality conditions (Eqs. 29.10–29.11).
        let x = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.3, 0.0, 1.0, 0.0];
        let t = [0.3, 0.6, 1.0];
        let (xi, eta, r, n) = project(&[0, 1, 2, 3], &x, t).expect("projection");
        let h = 1e-6;
        let r_xi = sub(evaluate(&[0, 1, 2, 3], &x, xi + h, eta), evaluate(&[0, 1, 2, 3], &x, xi - h, eta));
        let r_eta = sub(evaluate(&[0, 1, 2, 3], &x, xi, eta + h), evaluate(&[0, 1, 2, 3], &x, xi, eta - h));
        assert!(dot(r_xi, sub(t, r)).abs() < 1e-9 && dot(r_eta, sub(t, r)).abs() < 1e-9);
        assert!(n[2] > 0.9 && inside(4, xi, eta));
        let (u, v, p, m) = project(&[0, 1, 3], &x, [0.25, 0.25, -2.0]).expect("triangle");
        assert!((u - 0.25).abs() < 1e-15 && (v - 0.25).abs() < 1e-15 && p[2] == 0.0 && m == [0.0, 0.0, 1.0]);
        assert!(!inside(3, 0.8, 0.3) && inside(4, 1.02, -1.02) && !inside(4, 1.03, 0.0));
    }
}
