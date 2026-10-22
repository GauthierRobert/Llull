//! A first-order Netgen mesh -> CalculiX element rows: node tags (Netgen point numbers, then mid-edge nodes), tetrahedra oriented to a
//! positive volume, second order by straight mid-edge nodes shared between neighbours (no curving, like the reference mesher's
//! SecondOrderLinear), the face triangles matched to their tetrahedron face, and the nodes on every B-rep edge.

use crate::common::{MeshError, MeshResult, Point};
use llull_netgen::MeshData;
use std::collections::{HashMap, HashSet};

/// CalculiX tet face labels over 0-based corner indices: 1 = 1-2-3, 2 = 1-4-2, 3 = 2-4-3, 4 = 3-4-1.
const CCX_FACES: [(i32, [usize; 3]); 4] = [(1, [0, 1, 2]), (2, [0, 3, 1]), (3, [1, 3, 2]), (4, [2, 3, 0])];
/// C3D10 mid-edge nodes 5..10 over 0-based corners: 1-2, 2-3, 3-1, 1-4, 2-4, 3-4.
const TET10_EDGES: [(usize, usize); 6] = [(0, 1), (1, 2), (2, 0), (0, 3), (1, 3), (2, 3)];

/// Node tags -> coordinates; mid-edge and centre nodes are added after the mesh points and shared by every element using them.
pub struct Nodes {
    pub coords: HashMap<usize, Point>,
    mids: HashMap<(usize, usize), usize>,
    next: usize,
}

impl Nodes {
    /// Netgen points (x, y, z each) as tags 1..=n.
    pub fn new(points: &[f64]) -> Self {
        let coords: HashMap<usize, Point> = points.chunks_exact(3).enumerate().map(|(i, p)| (i + 1, [p[0], p[1], p[2]])).collect();
        let next = coords.len() + 1;
        Self { coords, mids: HashMap::new(), next }
    }

    pub fn at(&self, tag: usize) -> MeshResult<Point> {
        self.coords.get(&tag).copied().ok_or_else(|| MeshError::new("FEA_MESH_FAILED", format!("Netgen point {tag} does not exist")))
    }

    /// A new node at `point`.
    pub fn add(&mut self, point: Point) -> usize {
        let tag = self.next;
        self.next += 1;
        self.coords.insert(tag, point);
        tag
    }

    /// The node halfway along edge a-b (created once per edge).
    pub fn mid(&mut self, a: usize, b: usize) -> MeshResult<usize> {
        let key = (a.min(b), a.max(b));
        if let Some(&tag) = self.mids.get(&key) {
            return Ok(tag);
        }
        let (pa, pb) = (self.at(a)?, self.at(b)?);
        let tag = self.add([0, 1, 2].map(|i| (pa[i] + pb[i]) / 2.0));
        self.mids.insert(key, tag);
        Ok(tag)
    }
}

fn tag(value: i32) -> MeshResult<usize> {
    usize::try_from(value).ok().filter(|&t| t > 0).ok_or_else(|| MeshError::new("FEA_MESH_FAILED", format!("Netgen point number {value}")))
}

fn signed_volume(nodes: &Nodes, c: &[usize; 4]) -> MeshResult<f64> {
    let [p0, p1, p2, p3] = [nodes.at(c[0])?, nodes.at(c[1])?, nodes.at(c[2])?, nodes.at(c[3])?];
    let (a, b, d) = ([0, 1, 2].map(|i| p1[i] - p0[i]), [0, 1, 2].map(|i| p2[i] - p0[i]), [0, 1, 2].map(|i| p3[i] - p0[i]));
    Ok(a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0]) + a[2] * (b[0] * d[1] - b[1] * d[0]))
}

/// The tetrahedra of `mesh` filling a kept domain, as C3D4 / C3D10 rows of positive volume.
pub fn tet_rows(mesh: &MeshData, nodes: &mut Nodes, keep: impl Fn(i32) -> bool, quadratic: bool) -> MeshResult<Vec<Vec<usize>>> {
    let mut rows = Vec::new();
    for (corners, &domain) in mesh.tets.chunks_exact(4).zip(&mesh.tet_domains) {
        if !keep(domain) {
            continue;
        }
        let mut c = [tag(corners[0])?, tag(corners[1])?, tag(corners[2])?, tag(corners[3])?];
        if signed_volume(nodes, &c)? < 0.0 {
            c.swap(1, 2);
        }
        let mut row = c.to_vec();
        if quadratic {
            for (a, b) in TET10_EDGES {
                row.push(nodes.mid(c[a], c[b])?);
            }
        }
        rows.push(row);
    }
    Ok(rows)
}

/// Sorted corner triple -> `(tet position, CalculiX face label)` of the first tet owning that face.
pub fn tet_faces(tets: &[Vec<usize>]) -> HashMap<[usize; 3], (usize, i32)> {
    let mut index = HashMap::new();
    for (position, tet) in tets.iter().enumerate() {
        for (label, corners) in CCX_FACES {
            let mut key = corners.map(|c| tet[c]);
            key.sort_unstable();
            index.entry(key).or_insert((position, label));
        }
    }
    index
}

/// The corner triangles of the surface elements, each with its face (Netgen face number).
pub fn surface_triangles(mesh: &MeshData) -> MeshResult<Vec<([usize; 3], i32)>> {
    mesh.surface
        .chunks_exact(4)
        .zip(&mesh.surface_faces)
        .map(|(corners, &face)| Ok(([tag(corners[0])?, tag(corners[1])?, tag(corners[2])?], face)))
        .collect()
}

pub type RegionNodes = HashMap<i32, HashSet<usize>>;
pub type RegionFaces = HashMap<i32, Vec<(usize, i32)>>;

/// Nodes (with mid-edge nodes when quadratic) and tet faces of each region, from triangles tagged with their region.
pub fn region_sets(
    triangles: &[([usize; 3], i32)],
    faces: &HashMap<[usize; 3], (usize, i32)>,
    nodes: &mut Nodes,
    quadratic: bool,
) -> MeshResult<(RegionNodes, RegionFaces)> {
    let (mut region_nodes, mut region_faces) = (RegionNodes::new(), RegionFaces::new());
    for &(triangle, region) in triangles {
        let mut key = triangle;
        key.sort_unstable();
        let Some(&hit) = faces.get(&key) else { continue };
        region_faces.entry(region).or_default().push(hit);
        let set = region_nodes.entry(region).or_default();
        set.extend(triangle);
        if quadratic {
            for (a, b) in [(0, 1), (1, 2), (2, 0)] {
                set.insert(nodes.mid(triangle[a], triangle[b])?);
            }
        }
    }
    Ok((region_nodes, region_faces))
}

/// Every node on each B-rep edge: segment ends, the segment's middle when the elements were split there (`split`, all-quad shells), and
/// the mid node of every (half) segment when quadratic.
pub fn curve_nodes(mesh: &MeshData, nodes: &mut Nodes, quadratic: bool, split: bool) -> MeshResult<RegionNodes> {
    let mut out = RegionNodes::new();
    for (ends, &edge) in mesh.segments.chunks_exact(2).zip(&mesh.segment_edges) {
        let (a, b) = (tag(ends[0])?, tag(ends[1])?);
        let pieces = if split {
            let middle = nodes.mid(a, b)?;
            vec![(a, middle), (middle, b)]
        } else {
            vec![(a, b)]
        };
        for (from, to) in pieces {
            let mid = if quadratic { Some(nodes.mid(from, to)?) } else { None };
            out.entry(edge).or_default().extend([from, to].into_iter().chain(mid));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_tet(order: [i32; 4]) -> MeshData {
        MeshData {
            points: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            tets: order.to_vec(),
            tet_domains: vec![1],
            surface: vec![1, 2, 3, 0],
            surface_faces: vec![5],
            segments: vec![1, 2],
            segment_edges: vec![7],
        }
    }

    #[test]
    fn tets_are_turned_to_a_positive_volume_with_shared_mid_nodes() {
        let mesh = unit_tet([1, 3, 2, 4]);
        let mut nodes = Nodes::new(&mesh.points);
        let rows = tet_rows(&mesh, &mut nodes, |_| true, true).unwrap();
        assert_eq!(rows[0][..4], [1, 2, 3, 4]);
        assert!(signed_volume(&nodes, &[rows[0][0], rows[0][1], rows[0][2], rows[0][3]]).unwrap() > 0.0);
        assert_eq!(nodes.at(rows[0][4]).unwrap(), [0.5, 0.0, 0.0], "node 5 is mid 1-2");
        assert_eq!(nodes.at(rows[0][9]).unwrap(), [0.0, 0.5, 0.5], "node 10 is mid 3-4");
        assert_eq!(nodes.mid(2, 1).unwrap(), rows[0][4], "one node per edge");
        assert!(tet_rows(&mesh, &mut nodes, |domain| domain != 1, false).unwrap().is_empty());
    }

    #[test]
    fn surface_triangles_find_their_tet_face_and_edges_their_nodes() {
        let mesh = unit_tet([1, 2, 3, 4]);
        let mut nodes = Nodes::new(&mesh.points);
        let rows = tet_rows(&mesh, &mut nodes, |_| true, true).unwrap();
        let (region_nodes, region_faces) = region_sets(&surface_triangles(&mesh).unwrap(), &tet_faces(&rows), &mut nodes, true).unwrap();
        assert_eq!(region_faces[&5], vec![(0, 1)]);
        assert_eq!(region_nodes[&5].len(), 6);
        let edges = curve_nodes(&mesh, &mut nodes, true, false).unwrap();
        assert_eq!(edges[&7], [1, 2, rows[0][4]].into_iter().collect());
        assert!(tag(0).is_err() && nodes.at(99).is_err());
    }
}
