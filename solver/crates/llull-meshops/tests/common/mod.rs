//! Meshes and topology checks shared by the decimation tests.
#![allow(dead_code)] // each test binary uses a part of it

use std::collections::{BTreeMap, BTreeSet};

pub type Mesh = (Vec<f64>, Vec<u32>);

/// xorshift64: a fixed pseudo-random stream in [0, 1).
pub fn stream(seed: u64) -> impl FnMut() -> f64 {
    let mut state = seed;
    move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Icosphere of radius 10 subdivided `level` times (outward wound, welded), each vertex pushed along its radius by up to `noise`.
pub fn sphere(level: usize, noise: f64, seed: u64) -> Mesh {
    let t = (1.0 + 5.0f64.sqrt()) / 2.0;
    let mut points: Vec<[f64; 3]> = vec![
        [-1.0, t, 0.0],
        [1.0, t, 0.0],
        [-1.0, -t, 0.0],
        [1.0, -t, 0.0],
        [0.0, -1.0, t],
        [0.0, 1.0, t],
        [0.0, -1.0, -t],
        [0.0, 1.0, -t],
        [t, 0.0, -1.0],
        [t, 0.0, 1.0],
        [-t, 0.0, -1.0],
        [-t, 0.0, 1.0],
    ];
    let mut faces: Vec<[u32; 3]> = vec![
        [0, 11, 5],
        [0, 5, 1],
        [0, 1, 7],
        [0, 7, 10],
        [0, 10, 11],
        [1, 5, 9],
        [5, 11, 4],
        [11, 10, 2],
        [10, 7, 6],
        [7, 1, 8],
        [3, 9, 4],
        [3, 4, 2],
        [3, 2, 6],
        [3, 6, 8],
        [3, 8, 9],
        [4, 9, 5],
        [2, 4, 11],
        [6, 2, 10],
        [8, 6, 7],
        [9, 8, 1],
    ];
    let unit = |p: [f64; 3]| {
        let n = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
        [p[0] / n, p[1] / n, p[2] / n]
    };
    for _ in 0..level {
        let mut cache = BTreeMap::new();
        let mut next = Vec::new();
        let mut midpoint = |a: u32, b: u32, points: &mut Vec<[f64; 3]>| -> u32 {
            *cache.entry((a.min(b), a.max(b))).or_insert_with(|| {
                let (p, q) = (points[a as usize], points[b as usize]);
                points.push([(p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0, (p[2] + q[2]) / 2.0]);
                points.len() as u32 - 1
            })
        };
        for f in &faces {
            let (ab, bc, ca) = (midpoint(f[0], f[1], &mut points), midpoint(f[1], f[2], &mut points), midpoint(f[2], f[0], &mut points));
            next.extend([[f[0], ab, ca], [f[1], bc, ab], [f[2], ca, bc], [ab, bc, ca]]);
        }
        faces = next;
    }
    let mut random = stream(seed);
    let positions = points
        .iter()
        .flat_map(|&p| {
            let u = unit(p);
            let r = 10.0 + (random() * 2.0 - 1.0) * noise;
            [u[0] * r, u[1] * r, u[2] * r]
        })
        .collect();
    (positions, faces.into_iter().flatten().collect())
}

/// `n` x `n` cells on [0, 10]^2, two triangles per cell wound +Z, `z(x, y)` the height; the cells in `holes` (column, row) are left out.
pub fn grid(n: usize, z: impl Fn(f64, f64) -> f64, holes: &[(usize, usize)]) -> Mesh {
    let h = 10.0 / n as f64;
    let mut positions = Vec::new();
    for j in 0..=n {
        for i in 0..=n {
            let (x, y) = (i as f64 * h, j as f64 * h);
            positions.extend([x, y, z(x, y)]);
        }
    }
    let id = |i: usize, j: usize| (j * (n + 1) + i) as u32;
    let mut indices = Vec::new();
    for j in 0..n {
        for i in 0..n {
            if !holes.contains(&(i, j)) {
                indices.extend([id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
            }
        }
    }
    (positions, indices)
}

pub fn point(positions: &[f64], v: u32) -> [f64; 3] {
    [positions[v as usize * 3], positions[v as usize * 3 + 1], positions[v as usize * 3 + 2]]
}

/// Twice the area vector of a triangle.
pub fn normal(positions: &[f64], t: &[u32]) -> [f64; 3] {
    let (a, b, c) = (point(positions, t[0]), point(positions, t[1]), point(positions, t[2]));
    let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
}

/// What the topology of a triangle list is, or why it is not a consistently wound manifold.
#[derive(Debug, PartialEq, Eq)]
pub struct Topology {
    pub vertices: usize,
    pub edges: usize,
    pub faces: usize,
    /// Edges used by one face.
    pub boundary_edges: Vec<(u32, u32)>,
}

impl Topology {
    pub fn euler(&self) -> i64 {
        self.vertices as i64 - self.edges as i64 + self.faces as i64
    }

    /// Number of closed boundary loops (connected components of the boundary edges).
    pub fn boundary_loops(&self) -> usize {
        let mut parent: BTreeMap<u32, u32> = BTreeMap::new();
        fn find(parent: &mut BTreeMap<u32, u32>, v: u32) -> u32 {
            let p = *parent.entry(v).or_insert(v);
            if p == v {
                return v;
            }
            let root = find(parent, p);
            parent.insert(v, root);
            root
        }
        for &(a, b) in &self.boundary_edges {
            let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
            parent.insert(ra, rb);
        }
        let vertices: Vec<u32> = parent.keys().copied().collect();
        vertices.iter().map(|&v| find(&mut parent, v)).collect::<BTreeSet<_>>().len()
    }
}

/// The topology of `indices`; panics unless every face has three distinct corners, every directed edge is used once and every edge by at most two
/// faces that traverse it in opposite directions (a manifold, consistently wound).
pub fn topology(indices: &[u32]) -> Topology {
    let mut directed: BTreeMap<(u32, u32), usize> = BTreeMap::new();
    for t in indices.chunks_exact(3) {
        assert!(t[0] != t[1] && t[1] != t[2] && t[0] != t[2], "a face with a repeated corner: {t:?}");
        for k in 0..3 {
            *directed.entry((t[k], t[(k + 1) % 3])).or_insert(0) += 1;
        }
    }
    assert!(
        directed.values().all(|&uses| uses == 1),
        "a directed edge is used twice: the winding is inconsistent or the surface is not a manifold"
    );
    let undirected: BTreeSet<(u32, u32)> = directed.keys().map(|&(a, b)| (a.min(b), a.max(b))).collect();
    let boundary_edges: Vec<(u32, u32)> =
        undirected.iter().copied().filter(|&(a, b)| !directed.contains_key(&(a, b)) || !directed.contains_key(&(b, a))).collect();
    Topology {
        vertices: indices.iter().copied().collect::<BTreeSet<_>>().len(),
        edges: undirected.len(),
        faces: indices.len() / 3,
        boundary_edges,
    }
}

/// Bytes of a result, for comparing two runs bit for bit.
pub fn bytes(positions: &[f64], indices: &[u32]) -> Vec<u8> {
    positions.iter().flat_map(|v| v.to_le_bytes()).chain(indices.iter().flat_map(|v| v.to_le_bytes())).collect()
}
