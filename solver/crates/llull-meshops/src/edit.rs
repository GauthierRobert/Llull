//! Mutable indexed triangle mesh with vertex -> faces adjacency (twin of `editMesh.ts`). Per-vertex face lists keep JavaScript `Set`
//! semantics (insertion order, re-adding keeps the position, deleting shifts), because collapse order feeds later floating-point sums.

use crate::geom::{normal_of, Vec3};

pub struct EditMesh {
    pub pos: Vec<f64>,
    pub v_alive: Vec<bool>,
    pub faces: Vec<u32>,
    pub f_alive: Vec<bool>,
    pub v_faces: Vec<Vec<u32>>,
    pub live_faces: usize,
}

impl EditMesh {
    pub fn new(positions: &[f64], triangles: &[u32]) -> Self {
        let vertices = positions.len() / 3;
        let faces = triangles.len() / 3;
        let mut v_faces: Vec<Vec<u32>> = vec![Vec::new(); vertices];
        for f in 0..faces {
            for k in 0..3 {
                let list = &mut v_faces[triangles[f * 3 + k] as usize];
                if !list.contains(&(f as u32)) {
                    list.push(f as u32);
                }
            }
        }
        Self {
            pos: positions.to_vec(),
            v_alive: vec![true; vertices],
            faces: triangles.to_vec(),
            f_alive: vec![true; faces],
            v_faces,
            live_faces: faces,
        }
    }

    pub fn vertex_total(&self) -> usize {
        self.v_alive.len()
    }

    pub fn p(&self, v: u32) -> Vec3 {
        let i = v as usize * 3;
        [self.pos[i], self.pos[i + 1], self.pos[i + 2]]
    }

    pub fn set_p(&mut self, v: u32, at: Vec3) {
        let i = v as usize * 3;
        self.pos[i..i + 3].copy_from_slice(&at);
    }

    pub fn corners(&self, f: u32) -> [u32; 3] {
        let i = f as usize * 3;
        [self.faces[i], self.faces[i + 1], self.faces[i + 2]]
    }

    fn add_to_set(&mut self, v: u32, f: u32) {
        let list = &mut self.v_faces[v as usize];
        if !list.contains(&f) {
            list.push(f);
        }
    }

    fn delete_from_set(&mut self, v: u32, f: u32) {
        let list = &mut self.v_faces[v as usize];
        if let Some(at) = list.iter().position(|&x| x == f) {
            list.remove(at);
        }
    }

    pub fn has_face(&self, v: u32, f: u32) -> bool {
        self.v_faces[v as usize].contains(&f)
    }

    pub fn remove_face(&mut self, f: u32) {
        if !self.f_alive[f as usize] {
            return;
        }
        self.f_alive[f as usize] = false;
        for v in self.corners(f) {
            self.delete_from_set(v, f);
        }
        self.live_faces -= 1;
    }

    pub fn set_face(&mut self, f: u32, a: u32, b: u32, c: u32) {
        for v in self.corners(f) {
            self.delete_from_set(v, f);
        }
        let i = f as usize * 3;
        self.faces[i] = a;
        self.faces[i + 1] = b;
        self.faces[i + 2] = c;
        for v in [a, b, c] {
            self.add_to_set(v, f);
        }
    }

    /// Neighbour vertices of `v`, ascending.
    pub fn ring(&self, v: u32) -> Vec<u32> {
        let mut out: Vec<u32> = Vec::new();
        for &f in &self.v_faces[v as usize] {
            for w in self.corners(f) {
                if w != v {
                    out.push(w);
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Faces using the edge `a`-`b`, ascending.
    pub fn faces_on_edge(&self, a: u32, b: u32) -> Vec<u32> {
        let mut out: Vec<u32> = self.v_faces[a as usize].iter().copied().filter(|f| self.v_faces[b as usize].contains(f)).collect();
        out.sort_unstable();
        out
    }

    /// Third vertex of face `f` besides `a` and `b`.
    pub fn opposite(&self, f: u32, a: u32, b: u32) -> u32 {
        let [x, y, z] = self.corners(f);
        if x != a && x != b {
            x
        } else if y != a && y != b {
            y
        } else {
            z
        }
    }

    pub fn is_boundary_edge(&self, a: u32, b: u32) -> bool {
        self.faces_on_edge(a, b).len() == 1
    }

    pub fn is_boundary_vertex(&self, v: u32) -> bool {
        self.ring(v).into_iter().any(|w| self.is_boundary_edge(v, w))
    }

    pub fn face_normal(&self, f: u32) -> Vec3 {
        let [a, b, c] = self.corners(f);
        normal_of(self.p(a), self.p(b), self.p(c))
    }

    /// Remove vertex `u`, merging it into `v`: faces holding both vanish, the others swap `u` for `v`.
    pub fn collapse(&mut self, u: u32, v: u32) {
        let snapshot = self.v_faces[u as usize].clone();
        for f in snapshot {
            if self.has_face(v, f) {
                self.remove_face(f);
            } else {
                let [a, b, c] = self.corners(f);
                let swap = |x: u32| if x == u { v } else { x };
                self.set_face(f, swap(a), swap(b), swap(c));
            }
        }
        self.v_alive[u as usize] = false;
    }

    /// Compact, canonical output: faces in ascending index, vertices in first-use order.
    pub fn to_mesh(&self) -> (Vec<f64>, Vec<u32>) {
        let mut remap = vec![u32::MAX; self.v_alive.len()];
        let mut positions: Vec<f64> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        for f in 0..self.f_alive.len() {
            if !self.f_alive[f] {
                continue;
            }
            for v in self.corners(f as u32) {
                if remap[v as usize] == u32::MAX {
                    remap[v as usize] = (positions.len() / 3) as u32;
                    positions.extend_from_slice(&self.pos[v as usize * 3..v as usize * 3 + 3]);
                }
                indices.push(remap[v as usize]);
            }
        }
        (positions, indices)
    }
}
