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

    /// Fills `ring` with the neighbour vertices of `v`, ascending; true when `v` is on the boundary (a neighbour shares a single face with it).
    pub fn ring_into(&self, v: u32, ring: &mut Vec<u32>) -> bool {
        ring.clear();
        for &f in &self.v_faces[v as usize] {
            let others = self.corners(f).map(|w| (w != v).then_some(w));
            for (k, w) in others.into_iter().enumerate() {
                // a face holds each neighbour once, whatever its corners are (JavaScript Set semantics)
                if let Some(w) = w.filter(|&w| !others[..k].contains(&Some(w))) {
                    ring.push(w);
                }
            }
        }
        ring.sort_unstable();
        let boundary = ring.chunk_by(|x, y| x == y).any(|faces_on_edge| faces_on_edge.len() == 1);
        ring.dedup();
        boundary
    }

    /// Fills `ring` with the neighbours of `v` (ascending) and, for each, the number of faces of `v` that use the edge to it (1 = boundary edge).
    pub fn neighbours_into(&self, v: u32, ring: &mut Vec<(u32, u32)>) {
        ring.clear();
        for &f in &self.v_faces[v as usize] {
            let others = self.corners(f).map(|w| (w != v).then_some(w));
            for (k, w) in others.into_iter().enumerate() {
                // a face holds each neighbour once, whatever its corners are (JavaScript Set semantics)
                if let Some(w) = w.filter(|&w| !others[..k].contains(&Some(w))) {
                    ring.push((w, 1));
                }
            }
        }
        ring.sort_unstable();
        let mut kept = 0;
        for i in 0..ring.len() {
            if kept > 0 && ring[kept - 1].0 == ring[i].0 {
                ring[kept - 1].1 += 1;
            } else {
                ring[kept] = ring[i];
                kept += 1;
            }
        }
        ring.truncate(kept);
    }

    /// Fills `faces` with the faces using the edge `a`-`b`, ascending.
    pub fn faces_on_edge_into(&self, a: u32, b: u32, faces: &mut Vec<u32>) {
        faces.clear();
        faces.extend(self.v_faces[a as usize].iter().copied().filter(|f| self.v_faces[b as usize].contains(f)));
        faces.sort_unstable();
    }

    /// True when at least one face uses the edge `a`-`b`.
    pub fn has_edge(&self, a: u32, b: u32) -> bool {
        self.v_faces[a as usize].iter().any(|f| self.v_faces[b as usize].contains(f))
    }

    /// True when `v` is on the boundary (a neighbour shares a single face with it).
    pub fn is_boundary_vertex(&self, v: u32) -> bool {
        let mut ring = Vec::new();
        self.ring_into(v, &mut ring)
    }

    /// True when exactly one face uses the edge `a`-`b`.
    pub fn is_boundary_edge(&self, a: u32, b: u32) -> bool {
        self.v_faces[a as usize].iter().filter(|f| self.v_faces[b as usize].contains(f)).take(2).count() == 1
    }

    /// True when face `f` runs a -> b (in that cyclic direction).
    pub fn has_directed(&self, f: u32, a: u32, b: u32) -> bool {
        let [x, y, z] = self.corners(f);
        (x == a && y == b) || (y == a && z == b) || (z == a && x == b)
    }

    pub fn add_vertex(&mut self, at: Vec3) -> u32 {
        self.pos.extend_from_slice(&at);
        self.v_alive.push(true);
        self.v_faces.push(Vec::new());
        (self.v_alive.len() - 1) as u32
    }

    pub fn add_face(&mut self, a: u32, b: u32, c: u32) -> u32 {
        let f = self.f_alive.len() as u32;
        self.faces.extend_from_slice(&[a, b, c]);
        self.f_alive.push(true);
        for v in [a, b, c] {
            self.add_to_set(v, f);
        }
        self.live_faces += 1;
        f
    }

    /// Split the edge `a`-`b` at a new vertex placed at `at`; every face on the edge becomes two. Returns the new vertex.
    pub fn split(&mut self, a: u32, b: u32, at: Vec3) -> u32 {
        let m = self.add_vertex(at);
        let mut shared = Vec::new();
        self.faces_on_edge_into(a, b, &mut shared);
        for f in shared {
            let c = self.opposite(f, a, b);
            if self.has_directed(f, a, b) {
                self.set_face(f, a, m, c);
                self.add_face(m, b, c);
            } else {
                self.set_face(f, b, m, c);
                self.add_face(m, a, c);
            }
        }
        m
    }

    /// Flip the interior edge `a`-`b` to the diagonal between the two opposite vertices; false when it is not an interior edge.
    pub fn flip(&mut self, a: u32, b: u32) -> bool {
        let mut shared = Vec::new();
        self.faces_on_edge_into(a, b, &mut shared);
        if shared.len() != 2 {
            return false;
        }
        let (f1, second) = if self.has_directed(shared[0], a, b) { (shared[0], shared[1]) } else { (shared[1], shared[0]) };
        let c = self.opposite(f1, a, b);
        let d = self.opposite(second, a, b);
        self.set_face(f1, a, d, c);
        self.set_face(second, d, b, c);
        true
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

    pub fn face_normal(&self, f: u32) -> Vec3 {
        let [a, b, c] = self.corners(f);
        normal_of(self.p(a), self.p(b), self.p(c))
    }

    /// Remove vertex `u`, merging it into `v`: faces holding both vanish, the others swap `u` for `v`.
    pub fn collapse(&mut self, u: u32, v: u32) {
        let snapshot = std::mem::take(&mut self.v_faces[u as usize]);
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

#[cfg(test)]
mod tests {
    use super::EditMesh;

    /// Two triangles sharing the edge 1-2, and a lone face 4-5-6 apart.
    fn pair() -> EditMesh {
        EditMesh::new(&[0.0; 21], &[0, 1, 2, 1, 3, 2, 4, 5, 6])
    }

    #[test]
    fn the_ring_is_ascending_and_flags_a_vertex_with_an_edge_of_one_face() {
        let mesh = pair();
        let mut ring = Vec::new();
        assert!(mesh.ring_into(1, &mut ring));
        assert_eq!(ring, [0, 2, 3]);
        assert!(mesh.ring_into(0, &mut ring));
        assert_eq!(ring, [1, 2]);
        // a face that repeats a corner counts each neighbour once
        let degenerate = EditMesh::new(&[0.0; 9], &[0, 1, 1]);
        degenerate.ring_into(0, &mut ring);
        assert_eq!(ring, [1]);
        // a vertex inside a closed fan has no edge of one face
        let fan = EditMesh::new(&[0.0; 15], &[0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]);
        assert!(!fan.ring_into(0, &mut ring));
    }

    #[test]
    fn faces_on_an_edge_are_ascending_and_collapse_merges_the_vertex_into_the_other() {
        let mut mesh = pair();
        let mut faces = Vec::new();
        mesh.faces_on_edge_into(2, 1, &mut faces);
        assert_eq!(faces, [0, 1]);
        mesh.faces_on_edge_into(0, 3, &mut faces);
        assert!(faces.is_empty());
        mesh.collapse(1, 2);
        assert_eq!((mesh.live_faces, mesh.v_alive[1], mesh.f_alive.clone()), (1, false, vec![false, false, true]));
        assert_eq!(mesh.to_mesh().1, [0, 1, 2]);
    }
}
