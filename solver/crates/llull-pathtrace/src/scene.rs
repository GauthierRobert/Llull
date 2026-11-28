//! Scene geometry: meshes (one BLAS each) placed by instances (one TLAS), ray queries in world space and the surface point of a hit.
//! An instance ray is moved into mesh space with the instance's inverse affine and not renormalised, so `t` is the same in both spaces.

use crate::bvh::{Aabb, Bvh};
use crate::math::{v3, Affine32, Vec3};

#[derive(Debug, Clone)]
pub struct Mesh {
    /// Triangles as global vertex indices, in BLAS leaf order.
    pub triangles: Vec<[u32; 3]>,
    pub bvh: Bvh,
}

#[derive(Debug, Clone, Copy)]
pub struct Instance {
    pub mesh: u32,
    pub material: u32,
    pub to_world: Affine32,
    pub to_local: Affine32,
}

#[derive(Debug, Clone)]
pub struct Geometry {
    pub positions: Vec<Vec3>,
    pub normals: Vec<Vec3>,
    pub uvs: Vec<[f32; 2]>,
    pub meshes: Vec<Mesh>,
    pub instances: Vec<Instance>,
    pub tlas: Bvh,
}

#[derive(Debug, Clone, Copy)]
pub struct Hit {
    pub t: f32,
    pub instance: u32,
    pub triangle: u32,
    pub u: f32,
    pub v: f32,
}

/// Shading inputs at a hit, in world space. `ng` points to the same side as the interpolated normal.
#[derive(Debug, Clone, Copy)]
pub struct SurfacePoint {
    pub p: Vec3,
    pub ng: Vec3,
    pub ns: Vec3,
    pub uv: [f32; 2],
    /// Per-triangle tangent / bitangent from the UVs (zero when the UVs are degenerate).
    pub tangent: Vec3,
    pub bitangent: Vec3,
    pub material: u32,
}

/// Möller-Trumbore; (t, u, v) of a hit with t in (0, t_max).
fn intersect_triangle(origin: Vec3, direction: Vec3, a: Vec3, b: Vec3, c: Vec3, t_max: f32) -> Option<(f32, f32, f32)> {
    let e1 = b - a;
    let e2 = c - a;
    let p = direction.cross(e2);
    let det = e1.dot(p);
    if det == 0.0 || !det.is_finite() {
        return None;
    }
    let inv = 1.0 / det;
    let s = origin - a;
    let u = s.dot(p) * inv;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = s.cross(e1);
    let v = direction.dot(q) * inv;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = e2.dot(q) * inv;
    (t > 0.0 && t < t_max).then_some((t, u, v))
}

impl Mesh {
    pub fn build(positions: &[Vec3], triangles: Vec<[u32; 3]>) -> Mesh {
        let boxes: Vec<Aabb> = triangles
            .iter()
            .map(|t| {
                let mut b = Aabb::EMPTY;
                for &vertex in t {
                    b.grow(positions[vertex as usize]);
                }
                b
            })
            .collect();
        let mut bvh = Bvh::build(&boxes);
        let ordered: Vec<[u32; 3]> = bvh.order.iter().map(|&i| triangles[i as usize]).collect();
        bvh.order = (0..ordered.len() as u32).collect();
        Mesh { triangles: ordered, bvh }
    }
}

impl Geometry {
    /// Builds the TLAS over the instances' world boxes (from each BLAS box's eight corners).
    pub fn new(positions: Vec<Vec3>, normals: Vec<Vec3>, uvs: Vec<[f32; 2]>, meshes: Vec<Mesh>, instances: Vec<Instance>) -> Geometry {
        let boxes: Vec<Aabb> = instances
            .iter()
            .map(|instance| {
                let local = meshes[instance.mesh as usize].bvh.bounds();
                let mut b = Aabb::EMPTY;
                if meshes[instance.mesh as usize].triangles.is_empty() {
                    return Aabb { min: Vec3::splat(f32::MAX), max: Vec3::splat(f32::MAX) };
                }
                for corner in 0..8 {
                    let pick = |bit: usize, low: f32, high: f32| if corner & bit == 0 { low } else { high };
                    let p = v3(pick(1, local.min.x, local.max.x), pick(2, local.min.y, local.max.y), pick(4, local.min.z, local.max.z));
                    b.grow(instance.to_world.point(p));
                }
                b
            })
            .collect();
        let tlas = Bvh::build(&boxes);
        Geometry { positions, normals, uvs, meshes, instances, tlas }
    }

    pub fn triangle_count(&self) -> usize {
        self.meshes.iter().map(|m| m.triangles.len()).sum()
    }

    fn walk(&self, origin: Vec3, direction: Vec3, t_max: f32, any: bool) -> Option<Hit> {
        let mut best: Option<Hit> = None;
        self.tlas.traverse(origin, direction, t_max, any, |instance_index, limit| {
            let instance = &self.instances[instance_index as usize];
            let mesh = &self.meshes[instance.mesh as usize];
            let o = instance.to_local.point(origin);
            let d = instance.to_local.vector(direction);
            let mut found = None;
            mesh.bvh.traverse(o, d, limit, any, |triangle, limit| {
                let [a, b, c] = mesh.triangles[triangle as usize];
                let (pa, pb, pc) = (self.positions[a as usize], self.positions[b as usize], self.positions[c as usize]);
                let (t, u, v) = intersect_triangle(o, d, pa, pb, pc, limit)?;
                found = Some(Hit { t, instance: instance_index, triangle, u, v });
                Some(t)
            })?;
            best = found;
            found.map(|h| h.t)
        });
        best
    }

    pub fn intersect(&self, origin: Vec3, direction: Vec3, t_max: f32) -> Option<Hit> {
        self.walk(origin, direction, t_max, false)
    }

    pub fn occluded(&self, origin: Vec3, direction: Vec3, t_max: f32) -> bool {
        self.walk(origin, direction, t_max, true).is_some()
    }

    pub fn surface(&self, hit: &Hit) -> SurfacePoint {
        let instance = &self.instances[hit.instance as usize];
        let [a, b, c] = self.meshes[instance.mesh as usize].triangles[hit.triangle as usize];
        let (a, b, c) = (a as usize, b as usize, c as usize);
        let w = 1.0 - hit.u - hit.v;
        let (pa, pb, pc) = (
            instance.to_world.point(self.positions[a]),
            instance.to_world.point(self.positions[b]),
            instance.to_world.point(self.positions[c]),
        );
        let p = pa * w + pb * hit.u + pc * hit.v;
        let (e1, e2) = (pb - pa, pc - pa);
        let mut ng = e1.cross(e2).normalized();
        let local_n = self.normals[a] * w + self.normals[b] * hit.u + self.normals[c] * hit.v;
        let mut ns = instance.to_local.transpose_vector(local_n).normalized();
        if !ns.is_finite() || ns.length() < 0.5 {
            ns = ng;
        }
        if ng.dot(ns) < 0.0 {
            ng = -ng;
        }
        let (ua, ub, uc) = (self.uvs[a], self.uvs[b], self.uvs[c]);
        let uv = [ua[0] * w + ub[0] * hit.u + uc[0] * hit.v, ua[1] * w + ub[1] * hit.u + uc[1] * hit.v];
        let (du1, dv1, du2, dv2) = (ub[0] - ua[0], ub[1] - ua[1], uc[0] - ua[0], uc[1] - ua[1]);
        let r = du1 * dv2 - du2 * dv1;
        let (tangent, bitangent) = if r.abs() > 1e-12 {
            let inv = 1.0 / r;
            ((e1 * dv2 - e2 * dv1) * inv, (e2 * du1 - e1 * du2) * inv)
        } else {
            (Vec3::ZERO, Vec3::ZERO)
        };
        SurfacePoint { p, ng, ns, uv, tangent, bitangent, material: instance.material }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Affine;

    #[test]
    fn instanced_rays_hit_the_transformed_triangle() {
        let positions = vec![v3(0.0, 0.0, 0.0), v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0)];
        let normals = vec![v3(0.0, 0.0, 1.0); 3];
        let uvs = vec![[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]];
        let mesh = Mesh::build(&positions, vec![[0, 1, 2]]);
        let shift = Affine { m: [[2.0, 0.0, 0.0, 5.0], [0.0, 2.0, 0.0, 0.0], [0.0, 0.0, 2.0, 0.0]] };
        let instances = vec![
            Instance { mesh: 0, material: 0, to_world: Affine::IDENTITY.to_f32(), to_local: Affine::IDENTITY.to_f32() },
            Instance { mesh: 0, material: 1, to_world: shift.to_f32(), to_local: shift.inverse().unwrap().to_f32() },
        ];
        let g = Geometry::new(positions, normals, uvs, vec![mesh], instances);
        let hit = g.intersect(v3(5.5, 0.5, 3.0), v3(0.0, 0.0, -1.0), f32::INFINITY).unwrap();
        assert_eq!(hit.instance, 1);
        assert!((hit.t - 3.0).abs() < 1e-6);
        let s = g.surface(&hit);
        assert!((s.p - v3(5.5, 0.5, 0.0)).length() < 1e-5 && (s.ns.z - 1.0).abs() < 1e-6 && s.material == 1);
        assert!(g.occluded(v3(0.2, 0.2, 1.0), v3(0.0, 0.0, -1.0), 2.0));
        assert!(!g.occluded(v3(0.2, 0.2, 1.0), v3(0.0, 0.0, -1.0), 0.5));
        assert!(g.intersect(v3(3.0, 3.0, 1.0), v3(0.0, 0.0, -1.0), f32::INFINITY).is_none());
    }
}
