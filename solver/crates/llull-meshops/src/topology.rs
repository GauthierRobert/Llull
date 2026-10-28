//! Edge, shell, boundary-loop and orientation structure of a welded indexed triangle mesh (twin of `buildTopology` in `topology.ts`). Faces repeating a vertex
//! index are degenerate: they own no edge and no shell. Edges are found by sorting the corner uses by (edge, face) instead of a hash map, which gives the same
//! groups: the use count of an edge, the first face that uses it and how many uses run from the lower to the higher vertex.

use rayon::prelude::*;

pub struct Topology {
    pub face_count: usize,
    pub edge_count: usize,
    /// Edges used by exactly one face, as directed `(from, to)` of that face, in face order.
    pub boundary_edges: Vec<(u32, u32)>,
    /// Edges used by more than two faces as `(low, high, uses)`, ascending.
    pub non_manifold_edges: Vec<(u32, u32, usize)>,
    /// Edges whose two faces traverse them in the same direction.
    pub inconsistent_edges: usize,
    /// The first face of each such edge.
    pub inconsistent_faces: Vec<u32>,
    /// Shell of each face (`NO_SHELL` for a degenerate face) and the number of shells, numbered by their first face.
    pub face_shell: Vec<u32>,
    pub shell_count: usize,
    /// Number of shared edges per shell (edges in the shell, any use count).
    pub shell_edges: Vec<usize>,
    /// Shells that own a boundary edge or a non-manifold edge.
    pub unclosed_shells: Vec<bool>,
    pub loops: Vec<Vec<u32>>,
    pub degenerate_faces: usize,
    pub duplicate_faces: usize,
}

pub const NO_SHELL: u32 = u32::MAX;

/// The key of the edge between `a` and `b`: the lower index times the vertex count plus the higher one (what `topology.ts` packs into a double).
fn edge_key(a: u32, b: u32, vertex_count: usize) -> u64 {
    u64::from(a.min(b)) * vertex_count as u64 + u64::from(a.max(b))
}

fn find(parent: &mut [u32], mut x: u32) -> u32 {
    while parent[x as usize] != x {
        let grand = parent[parent[x as usize] as usize];
        parent[x as usize] = grand;
        x = grand;
    }
    x
}

/// Boundary edges chained into loops: each chain starts at the first unused edge and follows the first unused edge leaving its end vertex.
fn chain_loops(boundary: &[(u32, u32)]) -> Vec<Vec<u32>> {
    let mut order: Vec<u32> = (0..boundary.len() as u32).collect();
    order.sort_by_key(|&edge| (boundary[edge as usize].0, edge));
    let first_leaving = |vertex: u32| order.partition_point(|&edge| boundary[edge as usize].0 < vertex);
    let mut used = vec![false; boundary.len()];
    let mut loops = Vec::new();
    for start in 0..boundary.len() {
        if used[start] {
            continue;
        }
        let mut vertices = Vec::new();
        let mut edge = start;
        loop {
            used[edge] = true;
            let (from, to) = boundary[edge];
            vertices.push(from);
            let next = order[first_leaving(to)..]
                .iter()
                .take_while(|&&candidate| boundary[candidate as usize].0 == to)
                .find(|&&candidate| !used[candidate as usize]);
            match next {
                Some(&candidate) => edge = candidate as usize,
                None => break,
            }
        }
        loops.push(vertices);
    }
    loops
}

/// Topology of a welded mesh (`triangles`: three corner indices per face, each below `vertex_count`).
pub fn build_topology(vertex_count: usize, triangles: &[u32]) -> Topology {
    let face_count = triangles.len() / 3;
    let degenerate = |f: usize| {
        let (a, b, c) = (triangles[f * 3], triangles[f * 3 + 1], triangles[f * 3 + 2]);
        a == b || b == c || a == c
    };
    let degenerate_faces = (0..face_count).filter(|&f| degenerate(f)).count();
    // (edge key, corner slot = face * 3 + k, runs low -> high) for every directed edge of a non-degenerate face
    let mut uses: Vec<(u64, u32, bool)> = Vec::with_capacity((face_count - degenerate_faces) * 3);
    for f in (0..face_count).filter(|&f| !degenerate(f)) {
        for k in 0..3 {
            let (from, to) = (triangles[f * 3 + k], triangles[f * 3 + (k + 1) % 3]);
            uses.push((edge_key(from, to, vertex_count), (f * 3 + k) as u32, from < to));
        }
    }
    uses.par_sort_unstable_by_key(|&(key, slot, _)| (key, slot));
    let mut parent: Vec<u32> = (0..face_count as u32).collect();
    let mut groups: Vec<(usize, usize)> = Vec::new();
    let mut start = 0;
    while start < uses.len() {
        let end = start + uses[start..].iter().take_while(|u| u.0 == uses[start].0).count();
        let first = uses[start].1 / 3;
        for &(_, slot, _) in &uses[start + 1..end] {
            let (a, b) = (find(&mut parent, first), find(&mut parent, slot / 3));
            if a != b {
                parent[a.max(b) as usize] = a.min(b);
            }
        }
        groups.push((start, end));
        start = end;
    }
    let mut non_manifold_edges = Vec::new();
    let mut inconsistent_edges = 0;
    let mut inconsistent_faces = Vec::new();
    let mut boundary_slots = Vec::new();
    for &(start, end) in &groups {
        let key = uses[start].0;
        match end - start {
            1 => boundary_slots.push(uses[start].1),
            2 => {
                if uses[start..end].iter().filter(|u| u.2).count() != 1 {
                    inconsistent_edges += 1;
                    inconsistent_faces.push(uses[start].1 / 3);
                }
            }
            n => non_manifold_edges.push(((key / vertex_count as u64) as u32, (key % vertex_count as u64) as u32, n)),
        }
    }
    boundary_slots.sort_unstable();
    let boundary_edges: Vec<(u32, u32)> = boundary_slots
        .iter()
        .map(|&slot| {
            let (f, k) = (slot as usize / 3, slot as usize % 3);
            (triangles[f * 3 + k], triangles[f * 3 + (k + 1) % 3])
        })
        .collect();
    let mut shell_of_root = vec![NO_SHELL; face_count];
    let mut face_shell = vec![NO_SHELL; face_count];
    let mut shell_count = 0usize;
    for f in (0..face_count).filter(|&f| !degenerate(f)) {
        let root = find(&mut parent, f as u32) as usize;
        if shell_of_root[root] == NO_SHELL {
            shell_of_root[root] = shell_count as u32;
            shell_count += 1;
        }
        face_shell[f] = shell_of_root[root];
    }
    let mut shell_edges = vec![0usize; shell_count];
    let mut unclosed_shells = vec![false; shell_count];
    for &(start, end) in &groups {
        let shell = face_shell[uses[start].1 as usize / 3] as usize;
        shell_edges[shell] += 1;
        if end - start != 2 {
            unclosed_shells[shell] = true;
        }
    }
    let loops = chain_loops(&boundary_edges);
    let duplicate_faces = {
        let mut sets: Vec<[u32; 3]> = (0..face_count)
            .filter(|&f| !degenerate(f))
            .map(|f| {
                let mut corners = [triangles[f * 3], triangles[f * 3 + 1], triangles[f * 3 + 2]];
                corners.sort_unstable();
                corners
            })
            .collect();
        sets.par_sort_unstable();
        sets.windows(2).filter(|pair| pair[0] == pair[1]).count()
    };
    Topology {
        face_count,
        edge_count: groups.len(),
        boundary_edges,
        non_manifold_edges,
        inconsistent_edges,
        inconsistent_faces,
        face_shell,
        shell_count,
        shell_edges,
        unclosed_shells,
        loops,
        degenerate_faces,
        duplicate_faces,
    }
}
