//! Targets of a stuffed mesh (FLL-M1): `facesNear` -> the face region of the nearest boundary triangle, `pointsNear` -> the nearest node;
//! `edgesNear` is refused (a field has no B-rep edges). Lengths in document units.
//! A face region grows across neighbouring boundary triangles whose FIELD normals (the normalised gradient at the triangle centroid) turn by less
//! than CLASSIFY_ANGLE_DEG (the angle of llull-mesh's faceted parts). The facet normals would not do: stuffing cuts a sharp edge of the field
//! that is off the lattice planes into a strip of facets of intermediate normals, and a flood across facet normals chains around it onto the
//! next face; the field gradient jumps at the sharp edge, so the region stops there (14 FLL-D5).
//! @invariant a triangle whose gradient is zero or not finite falls back to its outward facet normal
//! @invariant nearest searches break distance ties by the lower index, so the sets do not depend on the thread count
//! @failure a point farther than max(1e-3 x diagonal, half a lattice spacing) from every face -> FEA_TARGET_UNRESOLVED; a point as near (1e-6 x
//!   diagonal) to two faces -> FEA_TARGET_AMBIGUOUS; edgesNear -> FEA_TARGET_UNRESOLVED

use crate::eval::Evaluator;
use crate::gradient::GradientScratch;
use crate::tet_quality::{cross, BoundaryFace};
use llull_bvh::geometry::closest_point_on_triangle;
use rayon::prelude::*;
use serde::Deserialize;

/// Same values as llull-mesh (`bins/llull-mesh/src/common.rs`), so a target resolves alike on a faceted part and on a field part.
const CLASSIFY_ANGLE_DEG: f64 = 40.0;
const AMBIGUOUS_REL: f64 = 1e-6;
const UNRESOLVED_REL: f64 = 1e-3;
/// A target point may lie this many lattice spacings from the faceted boundary (the chord error of the facets).
const UNRESOLVED_SPACINGS: f64 = 0.5;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSpec {
    pub key: String,
    #[serde(default)]
    pub faces_near: Vec<[f64; 3]>,
    #[serde(default)]
    pub points_near: Vec<[f64; 3]>,
    #[serde(default)]
    pub edges_near: Vec<[f64; 3]>,
    /// A target of no entity (`entityId: null`): only the nearest node of this part is reported; the host keeps the nearest over all parts.
    #[serde(default)]
    pub global: bool,
}

pub struct Resolved {
    pub key: String,
    pub nodes: Vec<u32>,
    /// (element index, CalculiX face label).
    pub faces: Vec<(u32, i32)>,
    pub residual: f64,
}

pub struct Nearest {
    pub key: String,
    pub node: u32,
    pub distance: f64,
}

pub struct TargetFailure {
    pub code: &'static str,
    pub message: String,
}

/// The mesh the targets resolve on: corner positions, mid nodes (index = corners + position, with their sorted edges) and boundary faces.
pub struct Surface<'a> {
    pub positions: &'a [[f64; 3]],
    pub mids: &'a [[f64; 3]],
    pub mid_edges: &'a [(u32, u32)],
    pub boundary: &'a [BoundaryFace],
    pub spacing: f64,
    /// The field, for the normals that classify face regions.
    pub evaluator: &'a Evaluator,
}

fn distance(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

fn point_text(p: &[f64; 3]) -> String {
    format!("({}, {}, {})", p[0], p[1], p[2])
}

impl Surface<'_> {
    fn triangle(&self, f: usize) -> [[f64; 3]; 3] {
        self.boundary[f].corners.map(|v| self.positions[v as usize])
    }

    fn diagonal(&self) -> f64 {
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for p in self.positions {
            for a in 0..3 {
                lo[a] = lo[a].min(p[a]);
                hi[a] = hi[a].max(p[a]);
            }
        }
        if self.positions.is_empty() {
            0.0
        } else {
            distance(&lo, &hi)
        }
    }

    fn face_distances(&self, p: &[f64; 3]) -> Vec<f64> {
        (0..self.boundary.len())
            .into_par_iter()
            .map(|f| {
                let t = self.triangle(f);
                distance(p, &closest_point_on_triangle(p, [&t[0], &t[1], &t[2]]))
            })
            .collect()
    }

    /// Neighbouring boundary faces across each edge shared by exactly two of them.
    fn neighbours(&self) -> Vec<Vec<u32>> {
        let mut edges: Vec<(u32, u32, u32)> = self
            .boundary
            .iter()
            .enumerate()
            .flat_map(|(f, face)| {
                let c = face.corners;
                [(c[0], c[1]), (c[1], c[2]), (c[2], c[0])].map(|(a, b)| (a.min(b), a.max(b), f as u32))
            })
            .collect();
        edges.par_sort_unstable();
        let mut out = vec![Vec::new(); self.boundary.len()];
        let mut start = 0;
        while start < edges.len() {
            let mut end = start + 1;
            while end < edges.len() && (edges[end].0, edges[end].1) == (edges[start].0, edges[start].1) {
                end += 1;
            }
            if end - start == 2 {
                let (a, b) = (edges[start].2, edges[start + 1].2);
                out[a as usize].push(b);
                out[b as usize].push(a);
            }
            start = end;
        }
        out
    }

    /// Unit field normal of boundary face `f` (gradient at its centroid), else its outward facet normal.
    fn normal(&self, scratch: &mut GradientScratch, f: usize) -> [f64; 3] {
        let t = self.triangle(f);
        let unit = |n: [f64; 3]| {
            let length = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            (length > 0.0 && length.is_finite()).then(|| n.map(|c| c / length))
        };
        let centre = [0, 1, 2].map(|i| (t[0][i] + t[1][i] + t[2][i]) / 3.0);
        let (_, gradient) = self.evaluator.value_gradient_at(scratch, centre[0], centre[1], centre[2]);
        // CalculiX face normals point into a positive element: the outward facet normal is the reverse
        let facet = cross(&[0, 1, 2].map(|i| t[2][i] - t[0][i]), &[0, 1, 2].map(|i| t[1][i] - t[0][i]));
        unit(gradient).or_else(|| unit(facet)).unwrap_or([0.0; 3])
    }

    /// The face region of `seed`: flood fill across edges whose two faces turn by less than the classification angle.
    fn region(&self, seed: usize, neighbours: &[Vec<u32>], normals: &[[f64; 3]]) -> Vec<bool> {
        let limit = CLASSIFY_ANGLE_DEG.to_radians().cos();
        let mut inside = vec![false; self.boundary.len()];
        inside[seed] = true;
        let mut stack = vec![seed];
        while let Some(f) = stack.pop() {
            for &g in &neighbours[f] {
                let g = g as usize;
                let cosine: f64 = (0..3).map(|k| normals[f][k] * normals[g][k]).sum();
                if !inside[g] && cosine > limit {
                    inside[g] = true;
                    stack.push(g);
                }
            }
        }
        inside
    }

    fn node(&self, v: u32) -> [f64; 3] {
        let corners = self.positions.len() as u32;
        if v < corners {
            self.positions[v as usize]
        } else {
            self.mids[(v - corners) as usize]
        }
    }

    fn nearest_node(&self, p: &[f64; 3]) -> (u32, f64) {
        let count = (self.positions.len() + self.mids.len()) as u32;
        let best = (0..count)
            .into_par_iter()
            .map(|v| (distance(p, &self.node(v)), v))
            .reduce(|| (f64::INFINITY, u32::MAX), |a, b| if b.0 < a.0 || (b.0 == a.0 && b.1 < a.1) { b } else { a });
        (best.1, best.0)
    }

    fn mid_node(&self, a: u32, b: u32) -> Option<u32> {
        self.mid_edges.binary_search(&(a.min(b), a.max(b))).ok().map(|m| self.positions.len() as u32 + m as u32)
    }
}

/// Resolves every target; `Nearest` entries are the global targets (nearest node of this part).
pub fn resolve(surface: &Surface<'_>, specs: &[TargetSpec]) -> Result<(Vec<Resolved>, Vec<Nearest>), TargetFailure> {
    let diag = surface.diagonal();
    let tolerance = (UNRESOLVED_REL * diag).max(UNRESOLVED_SPACINGS * surface.spacing);
    let needs_faces = specs.iter().any(|s| !s.faces_near.is_empty());
    let neighbours = if needs_faces { surface.neighbours() } else { Vec::new() };
    let normals: Vec<[f64; 3]> = if needs_faces {
        (0..surface.boundary.len())
            .into_par_iter()
            .map_init(|| GradientScratch::new(surface.evaluator.instrs.len()), |scratch, f| surface.normal(scratch, f))
            .collect()
    } else {
        Vec::new()
    };
    let (mut resolved, mut nearest) = (Vec::new(), Vec::new());
    for spec in specs {
        if !spec.edges_near.is_empty() {
            return Err(TargetFailure {
                code: "FEA_TARGET_UNRESOLVED",
                message: format!(
                    "target {}: edgesNear needs exact B-rep edges; an implicit field has none: use facesNear or pointsNear",
                    spec.key
                ),
            });
        }
        if spec.global {
            let best = spec.points_near.iter().map(|p| surface.nearest_node(p)).min_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
            if let Some((node, d)) = best {
                nearest.push(Nearest { key: spec.key.clone(), node, distance: d });
            }
            continue;
        }
        let mut in_region = vec![false; surface.boundary.len()];
        let mut residual = 0.0f64;
        for p in &spec.faces_near {
            let distances = surface.face_distances(p);
            let Some((seed, best)) =
                distances.iter().enumerate().min_by(|a, b| a.1.total_cmp(b.1).then(a.0.cmp(&b.0))).map(|(f, &d)| (f, d))
            else {
                return Err(TargetFailure { code: "FEA_TARGET_UNRESOLVED", message: format!("target {}: the part has no face", spec.key) });
            };
            if best > tolerance {
                return Err(TargetFailure {
                    code: "FEA_TARGET_UNRESOLVED",
                    message: format!(
                        "target {}: no face within {tolerance:.3} of point {} (nearest is {best:.3} away)",
                        spec.key,
                        point_text(p)
                    ),
                });
            }
            let region = surface.region(seed, &neighbours, &normals);
            let other = distances.iter().zip(&region).filter(|(_, &r)| !r).map(|(&d, _)| d).fold(f64::INFINITY, f64::min);
            if other - best <= AMBIGUOUS_REL * diag {
                return Err(TargetFailure {
                    code: "FEA_TARGET_AMBIGUOUS",
                    message: format!(
                        "target {}: point {} lies on the boundary between two faces; move it into the face interior",
                        spec.key,
                        point_text(p)
                    ),
                });
            }
            for (slot, r) in in_region.iter_mut().zip(region) {
                *slot |= r;
            }
            residual = residual.max(best);
        }
        let mut nodes: Vec<u32> = Vec::new();
        let mut faces: Vec<(u32, i32)> = Vec::new();
        for face in surface.boundary.iter().zip(&in_region).filter(|(_, &r)| r).map(|(face, _)| face) {
            faces.push((face.tet, face.label));
            let c = face.corners;
            nodes.extend(c);
            for (a, b) in [(0, 1), (1, 2), (2, 0)] {
                nodes.extend(surface.mid_node(c[a], c[b]));
            }
        }
        for p in &spec.points_near {
            let (node, d) = surface.nearest_node(p);
            nodes.push(node);
            residual = residual.max(d);
        }
        nodes.sort_unstable();
        nodes.dedup();
        faces.sort_unstable();
        resolved.push(Resolved { key: spec.key.clone(), nodes, faces, residual });
    }
    Ok((resolved, nearest))
}
