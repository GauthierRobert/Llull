//! Faceted (STL) parts: the facets, their classification into face regions (neighbouring facets are one face unless the edge between
//! them is sharper than CLASSIFY_ANGLE_DEG), distances to those faces, and the region of a meshed surface point (its nearest facet).

use crate::common::{malformed, MeshResult, Point, CLASSIFY_ANGLE_DEG};
use crate::sizes::push_points;
use llull_bvh::{geometry::closest_point_on_triangle, Aabb, Bvh};
use llull_netgen::Sizes;
use std::collections::HashMap;

pub struct StlSurface {
    pub facets: Vec<[Point; 3]>,
    /// Face region of each facet, numbered 1.. in order of first facet.
    pub region: Vec<i32>,
    pub regions: i32,
    bvh: Option<Bvh>,
}

fn sub(a: &Point, b: &Point) -> Point {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn unit_normal(f: &[Point; 3]) -> Point {
    let (u, v) = (sub(&f[1], &f[0]), sub(&f[2], &f[0]));
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    let length = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if length > 0.0 {
        n.map(|c| c / length)
    } else {
        n
    }
}

/// Facets of a binary STL, every vertex multiplied by `scale` in single precision (like a scaled STL file).
fn parse(data: &[u8], scale: f64) -> MeshResult<Vec<[Point; 3]>> {
    let count = data.get(80..84).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize).ok_or_else(|| malformed("STL header"))?;
    let records = data.get(84..84 + 50 * count).ok_or_else(|| malformed("truncated binary STL"))?;
    let factor = scale as f32;
    Ok(records
        .chunks_exact(50)
        .map(|record| {
            let value = |k: usize| {
                let b = &record[12 + 4 * k..16 + 4 * k];
                f64::from(f32::from_le_bytes([b[0], b[1], b[2], b[3]]) * factor)
            };
            [0, 1, 2].map(|v| [value(3 * v), value(3 * v + 1), value(3 * v + 2)])
        })
        .collect())
}

/// Face region per facet: flood fill across edges shared by exactly two facets whose normals differ by less than the angle.
fn classify(facets: &[[Point; 3]]) -> (Vec<i32>, i32) {
    let key = |p: &Point| p.map(f64::to_bits);
    let mut by_edge: HashMap<([u64; 3], [u64; 3]), Vec<usize>> = HashMap::new();
    for (i, f) in facets.iter().enumerate() {
        for (a, b) in [(0, 1), (1, 2), (2, 0)] {
            let (ka, kb) = (key(&f[a]), key(&f[b]));
            by_edge.entry(if ka < kb { (ka, kb) } else { (kb, ka) }).or_default().push(i);
        }
    }
    let normals: Vec<Point> = facets.iter().map(unit_normal).collect();
    let limit = CLASSIFY_ANGLE_DEG.to_radians().cos();
    let mut neighbours: Vec<Vec<usize>> = vec![Vec::new(); facets.len()];
    for owners in by_edge.values() {
        if let [a, b] = owners[..] {
            let cosine: f64 = (0..3).map(|k| normals[a][k] * normals[b][k]).sum();
            if cosine > limit {
                neighbours[a].push(b);
                neighbours[b].push(a);
            }
        }
    }
    let (mut region, mut regions) = (vec![0; facets.len()], 0);
    for start in 0..facets.len() {
        if region[start] != 0 {
            continue;
        }
        regions += 1;
        region[start] = regions;
        let mut stack = vec![start];
        while let Some(facet) = stack.pop() {
            for &next in &neighbours[facet] {
                if region[next] == 0 {
                    region[next] = regions;
                    stack.push(next);
                }
            }
        }
    }
    (region, regions)
}

impl StlSurface {
    pub fn from_binary(data: &[u8], scale: f64) -> MeshResult<Self> {
        let facets = parse(data, scale)?;
        let (region, regions) = classify(&facets);
        let boxes: Vec<Aabb> = facets
            .iter()
            .map(|f| Aabb {
                low: [0, 1, 2].map(|k| f[0][k].min(f[1][k]).min(f[2][k])),
                high: [0, 1, 2].map(|k| f[0][k].max(f[1][k]).max(f[2][k])),
            })
            .collect();
        Ok(Self { bvh: Bvh::build(&boxes), facets, region, regions })
    }

    /// `[min xyz, max xyz]` of the vertices.
    pub fn bounds(&self) -> [f64; 6] {
        let mut b = [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for p in self.facets.iter().flatten() {
            for k in 0..3 {
                b[k] = b[k].min(p[k]);
                b[k + 3] = b[k + 3].max(p[k]);
            }
        }
        if b[0] > b[3] {
            [0.0; 6]
        } else {
            b
        }
    }

    fn facet_distance(&self, facet: usize, point: &Point) -> (f64, Point) {
        let f = &self.facets[facet];
        let closest = closest_point_on_triangle(point, [&f[0], &f[1], &f[2]]);
        (crate::common::dist(point, &closest), closest)
    }

    /// Distance from `point` to face region `region` (its nearest facet).
    pub fn region_distance(&self, region: i32, point: &Point) -> f64 {
        (0..self.facets.len()).filter(|&i| self.region[i] == region).map(|i| self.facet_distance(i, point).0).fold(f64::INFINITY, f64::min)
    }

    /// The face region of the facet nearest to `point`.
    pub fn region_at(&self, point: &Point) -> i32 {
        self.bvh.as_ref().and_then(|bvh| bvh.nearest(point, &|i| self.facet_distance(i, point))).map_or(0, |hit| self.region[hit.item])
    }

    /// x, y, z of the 3 corners of every facet (Netgen's STL input).
    pub fn flat(&self) -> Vec<f64> {
        self.facets.iter().flatten().flatten().copied().collect()
    }

    /// Size points over the facets of `regions`, no further apart than `size`.
    pub fn region_sizes(&self, sizes: &mut Sizes, regions: &[i32], size: f64) {
        for (f, _) in self.facets.iter().zip(&self.region).filter(|(_, r)| regions.contains(r)) {
            let longest = [(0, 1), (1, 2), (2, 0)].iter().map(|&(a, b)| crate::common::dist(&f[a], &f[b])).fold(0.0, f64::max);
            let n = ((longest / size).ceil() as usize).clamp(1, 2000);
            let mut points = Vec::new();
            for i in 0..=n {
                for j in 0..=n - i {
                    let (s, t) = (i as f64 / n as f64, j as f64 / n as f64);
                    points.push([0, 1, 2].map(|k| f[0][k] + s * (f[1][k] - f[0][k]) + t * (f[2][k] - f[0][k])));
                }
            }
            push_points(sizes, &points, size);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Binary STL of the box [0, 2] x [0, 1] x [0, 1].
    fn box_stl() -> Vec<u8> {
        let corner =
            |i: usize| [if i & 1 != 0 { 2.0f32 } else { 0.0 }, if i & 2 != 0 { 1.0 } else { 0.0 }, if i & 4 != 0 { 1.0 } else { 0.0 }];
        let quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
        let mut data = vec![0u8; 80];
        data.extend_from_slice(&12u32.to_le_bytes());
        for q in quads {
            for t in [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] {
                data.extend_from_slice(&[0u8; 12]);
                for v in t {
                    for c in corner(v) {
                        data.extend_from_slice(&c.to_le_bytes());
                    }
                }
                data.extend_from_slice(&[0u8; 2]);
            }
        }
        data
    }

    #[test]
    fn a_box_has_six_faces_and_points_find_theirs() {
        let surface = StlSurface::from_binary(&box_stl(), 10.0).unwrap();
        assert_eq!((surface.facets.len(), surface.regions), (12, 6));
        assert_eq!(surface.bounds(), [0.0, 0.0, 0.0, 20.0, 10.0, 10.0]);
        let x0 = surface.region_at(&[0.0, 5.0, 5.0]);
        assert_eq!(surface.region_distance(x0, &[-1.0, 5.0, 5.0]), 1.0);
        assert_eq!(surface.region_distance(x0, &[20.0, 5.0, 5.0]), 20.0);
        assert_ne!(surface.region_at(&[20.0, 5.0, 5.0]), x0);
        let mut sizes = Sizes::default();
        surface.region_sizes(&mut sizes, &[x0], 2.5);
        assert!(sizes.points.chunks_exact(4).all(|p| p[0] == 0.0 && p[3] == 2.5) && sizes.points.len() >= 4 * 2 * 15);
        assert!(StlSurface::from_binary(&box_stl()[..100], 1.0).is_err());
    }
}
