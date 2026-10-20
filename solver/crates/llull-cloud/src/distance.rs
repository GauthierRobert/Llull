//! Signed distances from scan points to design entities (TECHNICAL_SPEC §5.9): analytic primitives evaluated exactly (pipe segment: the
//! radial distance |(x − a) × u| − r while the axial projection is inside the segment, else the distance to the cap rim region; box: the
//! signed box distance; sphere |x − c| − r) and triangle meshes through the `llull-bvh` tree (closest point by Voronoi regions, Ericson
//! §5.1.5), signed by the normal of the nearest triangle. An entity is the union of its primitives: d = minᵢ dᵢ.

use crate::cloud::Vec3;
use crate::linalg::{add, cross, dot, norm, scale, sub, unit};
use llull_bvh::geometry::closest_point_on_triangle;
use llull_bvh::{Aabb, Bvh};
use serde::Deserialize;

/// A design primitive in the document frame (metres) as the plugin sends it.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Primitive {
    /// Pipe / cylinder segment (open tube between the end planes).
    Cylinder {
        start: Vec3,
        end: Vec3,
        radius: f64,
    },
    /// Oriented box: unit axes and half sizes.
    Box {
        centre: Vec3,
        axes: [Vec3; 3],
        half: Vec3,
    },
    Sphere {
        centre: Vec3,
        radius: f64,
    },
    /// Triangles as a flat [x, y, z, …] list, 9 numbers per triangle, outward counter-clockwise.
    Mesh {
        triangles: Vec<f64>,
    },
}

/// A design entity: the union of its primitives, with the pipe axis when it is a straight pipe (for the axis-offset report).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitySpec {
    pub id: String,
    pub primitives: Vec<Primitive>,
    #[serde(default)]
    pub pipe: Option<PipeAxis>,
}

#[derive(Debug, Clone, Copy, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipeAxis {
    pub start: Vec3,
    pub end: Vec3,
    pub radius: f64,
}

enum Prepared {
    Cylinder { a: Vec3, u: Vec3, length: f64, radius: f64 },
    Box { centre: Vec3, axes: [Vec3; 3], half: Vec3 },
    Sphere { centre: Vec3, radius: f64 },
    Mesh { triangles: Vec<[Vec3; 3]>, normals: Vec<Vec3>, tree: Option<Bvh> },
}

/// An entity ready for distance queries, with its axis-aligned bounds.
pub struct Entity {
    pub id: String,
    pub low: Vec3,
    pub high: Vec3,
    pub pipe: Option<PipeAxis>,
    parts: Vec<Prepared>,
}

fn grow(low: &mut Vec3, high: &mut Vec3, p: &Vec3, pad: f64) {
    for a in 0..3 {
        low[a] = low[a].min(p[a] - pad);
        high[a] = high[a].max(p[a] + pad);
    }
}

impl Entity {
    pub fn prepare(spec: &EntitySpec) -> Entity {
        let mut low = [f64::INFINITY; 3];
        let mut high = [f64::NEG_INFINITY; 3];
        let mut parts = Vec::new();
        for primitive in &spec.primitives {
            match primitive {
                Primitive::Cylinder { start, end, radius } => {
                    let axis = sub(end, start);
                    let length = norm(&axis);
                    if let Some(u) = unit(&axis) {
                        grow(&mut low, &mut high, start, *radius);
                        grow(&mut low, &mut high, end, *radius);
                        parts.push(Prepared::Cylinder { a: *start, u, length, radius: *radius });
                    }
                }
                Primitive::Box { centre, axes, half } => {
                    let reach: Vec3 = std::array::from_fn(|k| (0..3).map(|i| (axes[i][k] * half[i]).abs()).sum());
                    grow(&mut low, &mut high, &sub(centre, &reach), 0.0);
                    grow(&mut low, &mut high, &add(centre, &reach), 0.0);
                    parts.push(Prepared::Box { centre: *centre, axes: *axes, half: *half });
                }
                Primitive::Sphere { centre, radius } => {
                    grow(&mut low, &mut high, centre, *radius);
                    parts.push(Prepared::Sphere { centre: *centre, radius: *radius });
                }
                Primitive::Mesh { triangles } => {
                    let tris: Vec<[Vec3; 3]> =
                        triangles.chunks_exact(9).map(|c| [[c[0], c[1], c[2]], [c[3], c[4], c[5]], [c[6], c[7], c[8]]]).collect();
                    let normals =
                        tris.iter().map(|t| unit(&cross(&sub(&t[1], &t[0]), &sub(&t[2], &t[0]))).unwrap_or([0.0, 0.0, 1.0])).collect();
                    let boxes: Vec<Aabb> = tris
                        .iter()
                        .map(|t| {
                            let mut lo = [f64::INFINITY; 3];
                            let mut hi = [f64::NEG_INFINITY; 3];
                            for v in t {
                                grow(&mut lo, &mut hi, v, 0.0);
                                grow(&mut low, &mut high, v, 0.0);
                            }
                            Aabb { low: lo, high: hi }
                        })
                        .collect();
                    parts.push(Prepared::Mesh { tree: Bvh::build(&boxes), triangles: tris, normals });
                }
            }
        }
        Entity { id: spec.id.clone(), low, high, pipe: spec.pipe, parts }
    }

    /// Whether `p` is within `pad` of the entity's bounds.
    pub fn near(&self, p: &Vec3, pad: f64) -> bool {
        (0..3).all(|a| p[a] >= self.low[a] - pad && p[a] <= self.high[a] + pad)
    }

    /// Signed distance (negative inside); +∞ for an entity without a usable primitive.
    pub fn distance(&self, p: &Vec3) -> f64 {
        self.parts.iter().map(|part| part_distance(part, p)).fold(f64::INFINITY, f64::min)
    }
}

fn part_distance(part: &Prepared, p: &Vec3) -> f64 {
    match part {
        Prepared::Cylinder { a, u, length, radius } => {
            let v = sub(p, a);
            let t = dot(&v, u);
            let radial = norm(&sub(&v, &scale(u, t))) - radius;
            if t >= 0.0 && t <= *length {
                radial
            } else {
                let beyond = if t < 0.0 { -t } else { t - length };
                (radial.max(0.0).powi(2) + beyond * beyond).sqrt()
            }
        }
        Prepared::Box { centre, axes, half } => {
            let d = sub(p, centre);
            let q: Vec3 = std::array::from_fn(|i| dot(&d, &axes[i]).abs() - half[i]);
            let outside = norm(&q.map(|v| v.max(0.0)));
            outside + q[0].max(q[1]).max(q[2]).min(0.0)
        }
        Prepared::Sphere { centre, radius } => norm(&sub(p, centre)) - radius,
        Prepared::Mesh { triangles, normals, tree } => {
            let Some(tree) = tree else { return f64::INFINITY };
            let leaf = |i: usize| {
                let [a, b, c] = &triangles[i];
                let q = closest_point_on_triangle(p, [a, b, c]);
                (norm(&sub(p, &q)), q)
            };
            match tree.nearest(p, &leaf) {
                Some(hit) => {
                    let sign = if dot(&sub(p, &hit.point), &normals[hit.item]) < 0.0 { -1.0 } else { 1.0 };
                    sign * hit.distance
                }
                None => f64::INFINITY,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entity(primitive: Primitive) -> Entity {
        Entity::prepare(&EntitySpec { id: "e".into(), primitives: vec![primitive], pipe: None })
    }

    #[test]
    fn analytic_distances_are_exact() {
        let tube = entity(Primitive::Cylinder { start: [0.0, 0.0, 0.0], end: [2.0, 0.0, 0.0], radius: 0.1 });
        assert!((tube.distance(&[1.0, 0.0, 0.3]) - 0.2).abs() < 1e-15);
        assert!((tube.distance(&[1.0, 0.05, 0.0]) + 0.05).abs() < 1e-15);
        assert!((tube.distance(&[3.0, 0.0, 0.1]) - 1.0).abs() < 1e-15);
        let cube =
            entity(Primitive::Box { centre: [0.0; 3], axes: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], half: [1.0, 2.0, 3.0] });
        assert!((cube.distance(&[2.0, 0.0, 0.0]) - 1.0).abs() < 1e-15);
        assert!((cube.distance(&[0.5, 0.0, 0.0]) + 0.5).abs() < 1e-15);
        assert!((cube.distance(&[2.0, 3.0, 0.0]) - 2f64.sqrt()).abs() < 1e-15);
        let ball = entity(Primitive::Sphere { centre: [1.0, 1.0, 1.0], radius: 0.5 });
        assert!((ball.distance(&[1.0, 1.0, 2.0]) - 0.5).abs() < 1e-15);
        assert!(ball.near(&[1.6, 1.0, 1.0], 0.2) && !ball.near(&[3.0, 1.0, 1.0], 0.2));
        assert_eq!(entity(Primitive::Mesh { triangles: vec![] }).distance(&[0.0; 3]), f64::INFINITY);
    }
}
