//! Dual contouring on the node grid: twin of `packages/core/src/geometry/field/dualContour.ts` (05 IMP 5.7 item 6; Ju, Losasso, Schaefer, Warren 2002).
//! One vertex per cell the surface crosses at the minimiser of the quadratic error of the Hermite data (8 bisections on the exact field, normals from
//! the exact gradient, pseudo-inverse of the normal matrix with eigenvalues below 0.1 of the largest dropped, mass-point regularisation, clamp to the
//! cell), one quad per crossed grid edge split on the shorter diagonal. Every number is computed with the operations of the TypeScript mesher in the same
//! order, so the mesh is identical vertex for vertex and triangle for triangle; rayon only parallelises independent edges and cells (the Hermite datum of
//! an edge and the vertex of a cell are pure functions), and the numbering follows the sequential scan of the quads.

use crate::eval::Evaluator;
use crate::gradient::GradientScratch;
use crate::jsnum::{hypot3, jmax, jmin};
use crate::sampling::Grid;
use crate::tetra::{IsoMesh, KeyBuild};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const SINGULAR_RATIO: f64 = 0.1;
const BISECTION_STEPS: usize = 8;

#[derive(Clone, Copy)]
struct Crossing {
    p: [f64; 3],
    n: [f64; 3],
}

/// Eigen-decomposition of the symmetric 3x3 matrix `m` (row major) by cyclic Jacobi rotations: eigenvalues and eigenvectors as columns of `vectors`.
fn eigen3(m: &[f64; 9]) -> ([f64; 3], [f64; 9]) {
    let mut a = *m;
    let mut v = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    for _ in 0..24 {
        if a[1].abs() + a[2].abs() + a[5].abs() < 1e-300 {
            break;
        }
        for (p, q) in [(0, 1), (0, 2), (1, 2)] {
            let apq = a[3 * p + q];
            if apq.abs() < 1e-300 {
                continue;
            }
            let theta = (a[3 * q + q] - a[3 * p + p]) / (2.0 * apq);
            let t = (if theta < 0.0 { -1.0 } else { 1.0 }) / (theta.abs() + (theta * theta + 1.0).sqrt());
            let c = 1.0 / (t * t + 1.0).sqrt();
            let s = t * c;
            for k in 0..3 {
                let (akp, akq) = (a[3 * k + p], a[3 * k + q]);
                a[3 * k + p] = c * akp - s * akq;
                a[3 * k + q] = s * akp + c * akq;
            }
            for k in 0..3 {
                let (apk, aqk) = (a[3 * p + k], a[3 * q + k]);
                a[3 * p + k] = c * apk - s * aqk;
                a[3 * q + k] = s * apk + c * aqk;
            }
            for k in 0..3 {
                let (vkp, vkq) = (v[3 * k + p], v[3 * k + q]);
                v[3 * k + p] = c * vkp - s * vkq;
                v[3 * k + q] = s * vkp + c * vkq;
            }
        }
    }
    ([a[0], a[4], a[8]], v)
}

/// Index (0..11, the order of the Hermite data of a cell) of the cube edge that starts at corner (cx, cy, cz) and runs along `axis`.
fn edge_index(cx: usize, cy: usize, cz: usize, axis: usize) -> usize {
    match axis {
        0 => (cy * 2 + cz) * 3,
        1 => (cx * 2 + cz) * 3 + 1,
        _ => (cx * 2 + cy) * 3 + 2,
    }
}

/// A cube face: its corner bits (x + 2 y + 4 z) in cyclic order and the cube edge between each corner and the next.
type Face = ([usize; 4], [usize; 4]);

fn faces() -> &'static [Face; 6] {
    static FACES: OnceLock<[Face; 6]> = OnceLock::new();
    FACES.get_or_init(|| {
        let mut faces = [([0; 4], [0; 4]); 6];
        for axis in 0..3 {
            for side in 0..2 {
                let (u, v) = ((axis + 1) % 3, (axis + 2) % 3);
                let coords: [[usize; 3]; 4] = [[0, 0], [1, 0], [1, 1], [0, 1]].map(|[a, b]| {
                    let mut c = [0; 3];
                    c[axis] = side;
                    c[u] = a;
                    c[v] = b;
                    c
                });
                let bit = |c: &[usize; 3]| c[0] + 2 * c[1] + 4 * c[2];
                let mut edges = [0; 4];
                for k in 0..4 {
                    let next = &coords[(k + 1) % 4];
                    let along = if k % 2 == 0 { u } else { v };
                    let near = if coords[k][along] == 0 { &coords[k] } else { next };
                    edges[k] = edge_index(near[0], near[1], near[2], along);
                }
                faces[axis * 2 + side] = (coords.map(|c| bit(&c)), edges);
            }
        }
        faces
    })
}

/// Sheet (smallest edge index of its surface piece, -1 for an uncrossed edge) of each of the 12 edges of a cell whose corner signs are `inside`, or
/// `None` when no face is ambiguous (four crossed edges). Edges on a common face are joined as a marching-cubes table would: a face with two crossings
/// joins them, an ambiguous face cuts off its outside corners (a rule of the signs of the face only, so the two cells sharing it agree).
fn cell_sheets(inside: &[bool; 8]) -> Option<[i8; 12]> {
    let mut parent: [usize; 12] = std::array::from_fn(|i| i);
    fn find(parent: &[usize; 12], mut i: usize) -> usize {
        while parent[i] != i {
            i = parent[i];
        }
        i
    }
    let join = |parent: &mut [usize; 12], a: usize, b: usize| {
        let (ra, rb) = (find(parent, a), find(parent, b));
        parent[ra.max(rb)] = ra.min(rb);
    };
    let mut ambiguous = false;
    for (corners, edges) in faces() {
        let crossed: [bool; 4] = std::array::from_fn(|k| inside[corners[k]] != inside[corners[(k + 1) % 4]]);
        let count = crossed.iter().filter(|&&c| c).count();
        if count == 2 {
            let pair: Vec<usize> = (0..4).filter(|&k| crossed[k]).map(|k| edges[k]).collect();
            join(&mut parent, pair[0], pair[1]);
        } else if count == 4 {
            ambiguous = true;
            for k in 0..4 {
                if !inside[corners[k]] {
                    join(&mut parent, edges[(k + 3) % 4], edges[k]);
                }
            }
        }
    }
    if !ambiguous {
        return None;
    }
    Some(std::array::from_fn(|idx| {
        let (d, axis) = (idx / 3, idx % 3);
        let (d1, d2) = (d >> 1, d & 1);
        let near = match axis {
            0 => [0, d1, d2],
            1 => [d1, 0, d2],
            _ => [d1, d2, 0],
        };
        let mut far = near;
        far[axis] = 1;
        let bit = |c: [usize; 3]| c[0] + 2 * c[1] + 4 * c[2];
        if inside[bit(near)] == inside[bit(far)] {
            -1
        } else {
            find(&parent, idx) as i8
        }
    }))
}

/// Minimiser of sum (n . (x - p))^2 near the mass point of the Hermite data, clamped to the box [lo, hi].
fn solve_qef(data: &[Crossing], lo: [f64; 3], hi: [f64; 3]) -> [f64; 3] {
    let count = data.len() as f64;
    let mass = [0, 1, 2].map(|axis| data.iter().fold(0.0, |sum, d| sum + d.p[axis]) / count);
    let mut ata = [0.0; 9];
    let mut atb = [0.0; 3];
    for d in data {
        let b = (0..3).fold(0.0, |sum, axis| sum + d.n[axis] * (d.p[axis] - mass[axis]));
        for i in 0..3 {
            for j in 0..3 {
                ata[3 * i + j] += d.n[i] * d.n[j];
            }
            atb[i] += d.n[i] * b;
        }
    }
    let (values, vectors) = eigen3(&ata);
    let largest = jmax(jmax(jmax(values[0].abs(), values[1].abs()), values[2].abs()), 1e-300);
    let mut shift = [0.0; 3];
    for (k, &lambda) in values.iter().enumerate() {
        if lambda.abs() < SINGULAR_RATIO * largest {
            continue;
        }
        let projection = (vectors[k] * atb[0] + vectors[3 + k] * atb[1] + vectors[6 + k] * atb[2]) / lambda;
        for (axis, s) in shift.iter_mut().enumerate() {
            *s += projection * vectors[3 * axis + k];
        }
    }
    [0, 1, 2].map(|axis| jmin(hi[axis], jmax(lo[axis], mass[axis] + shift[axis])))
}

struct Mesher<'a> {
    evaluator: &'a Evaluator,
    grid: &'a Grid,
    signs: &'a [u8],
    nodes: [usize; 3],
}

#[derive(Clone, Copy)]
struct Quad {
    cells: [u64; 4],
    edge: u64,
}

impl Mesher<'_> {
    fn node(&self, i: usize, j: usize, k: usize) -> u64 {
        (i + self.nodes[0] * (j + self.nodes[1] * k)) as u64
    }

    fn inside(&self, id: u64) -> bool {
        self.signs[id as usize] != 0
    }

    fn point(&self, i: usize, j: usize, k: usize) -> [f64; 3] {
        let v = self.grid.voxel;
        [self.grid.min[0] + i as f64 * v, self.grid.min[1] + j as f64 * v, self.grid.min[2] + k as f64 * v]
    }

    fn decode(&self, id: u64) -> (usize, usize, usize) {
        let id = id as usize;
        (id % self.nodes[0], (id / self.nodes[0]) % self.nodes[1], id / (self.nodes[0] * self.nodes[1]))
    }

    /// Hermite datum of the grid edge `key` (node * 3 + axis) leaving a node along its axis, refined on the exact field.
    fn crossing(&self, regs: &mut [f64], grad: &mut GradientScratch, key: u64) -> Crossing {
        let (id, axis) = (key / 3, (key % 3) as usize);
        let (i, j, k) = self.decode(id);
        let far = [i + usize::from(axis == 0), j + usize::from(axis == 1), k + usize::from(axis == 2)];
        let a = self.point(i, j, k);
        let b = self.point(far[0], far[1], far[2]);
        let along = |t: f64| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        let start_inside = self.inside(id);
        let (mut lo, mut hi) = (0.0, 1.0);
        for _ in 0..BISECTION_STEPS {
            let mid = (lo + hi) / 2.0;
            let [x, y, z] = along(mid);
            let value = self.evaluator.value_at(regs, x, y, z);
            if value.is_finite() && (value < 0.0) == start_inside {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let p = along((lo + hi) / 2.0);
        let (_, gradient) = self.evaluator.value_gradient_at(grad, p[0], p[1], p[2]);
        let length = hypot3(gradient[0], gradient[1], gradient[2]);
        let fallback = [f64::from(u8::from(axis == 0)), f64::from(u8::from(axis == 1)), f64::from(u8::from(axis == 2))];
        let n = if length > 1e-12 && length.is_finite() {
            [gradient[0] / length, gradient[1] / length, gradient[2] / length]
        } else if start_inside {
            fallback
        } else {
            fallback.map(|c| -c)
        };
        Crossing { p, n }
    }

    /// Sheets of cell `cell` (`None` when no face of the cell is ambiguous).
    fn sheets(&self, cell: u64) -> Option<[i8; 12]> {
        let (i, j, k) = self.decode(cell);
        let corner = |bit: usize| self.inside(self.node(i + (bit & 1), j + ((bit >> 1) & 1), k + (bit >> 2)));
        cell_sheets(&std::array::from_fn(corner))
    }

    /// Crossed edges (index in the 12-edge order of the TypeScript mesher, key = node * 3 + axis) of cell `cell`.
    fn cell_edges(&self, cell: u64) -> Vec<(usize, u64)> {
        let (i, j, k) = self.decode(cell);
        let mut keys = Vec::with_capacity(12);
        for d1 in 0..2 {
            for d2 in 0..2 {
                let edges = [(i, j + d1, k + d2, 0usize), (i + d1, j, k + d2, 1), (i + d1, j + d2, k, 2)];
                for (ei, ej, ek, axis) in edges {
                    let near = self.node(ei, ej, ek);
                    let far = self.node(ei + usize::from(axis == 0), ej + usize::from(axis == 1), ek + usize::from(axis == 2));
                    if self.inside(near) != self.inside(far) {
                        keys.push(((d1 * 2 + d2) * 3 + axis, near * 3 + axis as u64));
                    }
                }
            }
        }
        keys
    }

    /// Sheet of cell `cell` that holds the crossed edge `edge`, and whether the cell has an ambiguous face (otherwise its single sheet is 0).
    fn sheet_of(&self, cell: u64, edge: u64) -> (u8, bool) {
        let Some(sheets) = self.sheets(cell) else { return (0, false) };
        let (i, j, k) = self.decode(cell);
        let (ei, ej, ek) = self.decode(edge / 3);
        (sheets[edge_index(ei - i, ej - j, ek - k, (edge % 3) as usize)].max(0) as u8, true)
    }

    /// The quads of the three edge scans, in the order of the TypeScript mesher.
    fn quads(&self) -> Vec<Quad> {
        let [sx, sy, sz] = self.nodes;
        let mut quads = Vec::new();
        let mut push = |near: u64, far: u64, axis: u64, cells: [u64; 4]| {
            if self.inside(near) != self.inside(far) {
                quads.push(Quad { cells, edge: near * 3 + axis });
            }
        };
        for k in 1..sz - 1 {
            for j in 1..sy - 1 {
                for i in 0..sx - 1 {
                    let cells = [self.node(i, j - 1, k - 1), self.node(i, j, k - 1), self.node(i, j, k), self.node(i, j - 1, k)];
                    push(self.node(i, j, k), self.node(i + 1, j, k), 0, cells);
                }
            }
        }
        for k in 1..sz - 1 {
            for j in 0..sy - 1 {
                for i in 1..sx - 1 {
                    let cells = [self.node(i - 1, j, k - 1), self.node(i, j, k - 1), self.node(i, j, k), self.node(i - 1, j, k)];
                    push(self.node(i, j, k), self.node(i, j + 1, k), 1, cells);
                }
            }
        }
        for k in 0..sz - 1 {
            for j in 1..sy - 1 {
                for i in 1..sx - 1 {
                    let cells = [self.node(i - 1, j - 1, k), self.node(i, j - 1, k), self.node(i, j, k), self.node(i - 1, j, k)];
                    push(self.node(i, j, k), self.node(i, j, k + 1), 2, cells);
                }
            }
        }
        quads
    }
}

/// The mesh and the number of cells split into one vertex per sheet.
pub struct DualContoured {
    pub mesh: IsoMesh,
    pub split_cells: usize,
}

/// More triangles than the budget (the count the quads give).
#[derive(Debug, PartialEq, Eq)]
pub struct OverBudget(pub u64);

/// Mesh of {inside} by dual contouring. `signs` holds one flag per node (x fastest, 1 = value < 0). The caller checks the result is a closed
/// manifold (`null` in the TypeScript mesher means "use the tetrahedra").
pub fn dual_contour(evaluator: &Evaluator, grid: &Grid, signs: &[u8], max_triangles: u64) -> Result<DualContoured, OverBudget> {
    let nodes = grid.nodes();
    if nodes.iter().any(|&n| n < 3) {
        return Ok(DualContoured { mesh: IsoMesh { positions: Vec::new(), indices: Vec::new() }, split_cells: 0 });
    }
    let mesher = Mesher { evaluator, grid, signs, nodes };
    let quads = mesher.quads();
    let triangles = 2 * quads.len() as u64;
    if triangles > max_triangles {
        return Err(OverBudget(triangles));
    }
    // Vertices (a cell and its sheet) in the order of first use (a, b, c, d of each quad), numbered like the TypeScript `vertexOf`.
    let mut index_of: HashMap<u64, u32, KeyBuild> = HashMap::with_hasher(KeyBuild::default());
    let mut verts: Vec<(u64, u8)> = Vec::new();
    let mut split: HashSet<u64, KeyBuild> = HashSet::with_hasher(KeyBuild::default());
    let mut corners: Vec<[u32; 4]> = Vec::with_capacity(quads.len());
    for quad in &quads {
        corners.push(quad.cells.map(|cell| {
            let (sheet, ambiguous) = mesher.sheet_of(cell, quad.edge);
            if ambiguous {
                split.insert(cell);
            }
            *index_of.entry(cell * 16 + u64::from(sheet)).or_insert_with(|| {
                verts.push((cell, sheet));
                (verts.len() - 1) as u32
            })
        }));
    }
    drop(index_of);
    let scratch = || (vec![0.0; evaluator.instrs.len()], GradientScratch::new(evaluator.instrs.len()));
    let mut keys: Vec<u64> = verts.par_iter().flat_map_iter(|&(cell, _)| mesher.cell_edges(cell).into_iter().map(|(_, key)| key)).collect();
    keys.par_sort_unstable();
    keys.dedup();
    let data: Vec<Crossing> = keys.par_iter().map_init(scratch, |(regs, grad), &key| mesher.crossing(regs, grad, key)).collect();
    let datum = |key: u64| data[keys.binary_search(&key).expect("a crossed edge has a datum")];
    let vertices: Vec<[f64; 3]> = verts
        .par_iter()
        .map(|&(cell, sheet)| {
            let sheets = mesher.sheets(cell);
            let hermite: Vec<Crossing> = mesher
                .cell_edges(cell)
                .into_iter()
                .filter(|&(idx, _)| sheets.is_none_or(|s| s[idx] == sheet as i8))
                .map(|(_, key)| datum(key))
                .collect();
            let (i, j, k) = mesher.decode(cell);
            solve_qef(&hermite, mesher.point(i, j, k), mesher.point(i + 1, j + 1, k + 1))
        })
        .collect();
    let positions: Vec<f64> = vertices.iter().flatten().copied().collect();
    let dist = |a: u32, b: u32| {
        let (p, q) = (vertices[a as usize], vertices[b as usize]);
        hypot3(p[0] - q[0], p[1] - q[1], p[2] - q[2])
    };
    let mut indices: Vec<u32> = Vec::with_capacity(quads.len() * 6);
    for (quad, &[a, b, c, d]) in quads.iter().zip(&corners) {
        let n = datum(quad.edge).n;
        let ring = if dist(a, c) <= dist(b, d) { [a, b, c, a, c, d] } else { [b, c, d, b, d, a] };
        let (p, q, r) = (vertices[ring[0] as usize], vertices[ring[1] as usize], vertices[ring[2] as usize]);
        let (u, w) = ([q[0] - p[0], q[1] - p[1], q[2] - p[2]], [r[0] - p[0], r[1] - p[1], r[2] - p[2]]);
        let flip = (u[1] * w[2] - u[2] * w[1]) * n[0] + (u[2] * w[0] - u[0] * w[2]) * n[1] + (u[0] * w[1] - u[1] * w[0]) * n[2] < 0.0;
        for t in [0, 3] {
            let (x, y, z) = (ring[t], ring[t + 1], ring[t + 2]);
            if x == y || y == z || x == z {
                continue;
            }
            if flip {
                indices.extend([x, z, y]);
            } else {
                indices.extend([x, y, z]);
            }
        }
    }
    Ok(DualContoured { mesh: IsoMesh { positions, indices }, split_cells: split.len() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tape::Op;
    use crate::testkit::Tape;
    use crate::tetra::is_closed_manifold;

    fn signs_of(evaluator: &Evaluator, grid: &Grid) -> Vec<u8> {
        let [sx, sy, sz] = grid.nodes();
        let mut regs = vec![0.0; evaluator.instrs.len()];
        let snap = 1e-3 * grid.voxel;
        let mut signs = Vec::with_capacity(sx * sy * sz);
        for k in 0..sz {
            for j in 0..sy {
                for i in 0..sx {
                    let at = |axis: usize, n: usize| grid.min[axis] + n as f64 * grid.voxel;
                    let v = evaluator.value_at(&mut regs, at(0, i), at(1, j), at(2, k));
                    let v = if v.abs() < snap { snap } else { v };
                    signs.push(u8::from(v < 0.0));
                }
            }
        }
        signs
    }

    fn cube(half: f64) -> Evaluator {
        let mut t = Tape::new();
        let out = box_at(&mut t, [0.0; 3], half);
        t.finish(out)
    }

    fn box_at(t: &mut Tape, centre: [f64; 3], half: f64) -> i64 {
        let (x, y, z) = (t.x(), t.y(), t.z());
        let h = t.c(half);
        let mut worst = None;
        for (axis, p) in [x, y, z].into_iter().enumerate() {
            let c = t.c(centre[axis]);
            let shifted = t.bin(Op::Sub, p, c);
            let a = t.un(Op::Abs, shifted);
            let d = t.bin(Op::Sub, a, h);
            worst = Some(match worst {
                None => d,
                Some(w) => t.bin(Op::Max, w, d),
            });
        }
        worst.unwrap_or(0)
    }

    #[test]
    fn a_sphere_is_a_closed_manifold_with_vertices_inside_their_cells() {
        let mut t = Tape::new();
        let out = t.ball([0.0; 3], 4.0);
        let ev = t.finish(out);
        let grid = Grid::new([-6.0; 3], [6.0; 3], 0.5).unwrap();
        let mesh = dual_contour(&ev, &grid, &signs_of(&ev, &grid), u64::MAX).unwrap().mesh;
        assert!(!mesh.indices.is_empty() && is_closed_manifold(mesh.positions.len() / 3, &mesh.indices));
        let mut regs = vec![0.0; ev.instrs.len()];
        for p in mesh.positions.chunks_exact(3) {
            assert!(ev.value_at(&mut regs, p[0], p[1], p[2]).abs() < 0.05, "a QEF vertex sits on the sphere to a tenth of a voxel");
        }
    }

    #[test]
    fn a_cube_keeps_its_corner_exactly() {
        let ev = cube(2.5);
        let grid = Grid::new([-4.0; 3], [4.0; 3], 1.0).unwrap();
        let mesh = dual_contour(&ev, &grid, &signs_of(&ev, &grid), u64::MAX).unwrap().mesh;
        assert!(is_closed_manifold(mesh.positions.len() / 3, &mesh.indices));
        let corners = mesh.positions.chunks_exact(3).filter(|p| p.iter().all(|c| (c.abs() - 2.5).abs() < 0.01)).count();
        assert_eq!(corners, 8, "the eight sharp corners are vertices (to the bisection resolution)");
    }

    #[test]
    fn two_boxes_sharing_only_an_edge_are_one_closed_manifold_thanks_to_the_split_cells() {
        let mut t = Tape::new();
        let a = box_at(&mut t, [1.5, 1.5, 1.5], 2.0);
        let b = box_at(&mut t, [5.5, 5.5, 1.5], 2.0);
        let both = t.bin(Op::Min, a, b);
        let ev = t.finish(both);
        let grid = Grid::new([-2.0, -2.0, -2.0], [10.0, 10.0, 5.0], 1.0).unwrap();
        let signs = signs_of(&ev, &grid);
        let contoured = dual_contour(&ev, &grid, &signs, u64::MAX).unwrap();
        assert!(contoured.split_cells > 0, "the faces along the shared edge are ambiguous");
        assert!(is_closed_manifold(contoured.mesh.positions.len() / 3, &contoured.mesh.indices));
    }

    #[test]
    fn the_budget_counts_two_triangles_per_crossed_edge_and_tiny_grids_are_empty() {
        let ev = cube(2.5);
        let grid = Grid::new([-4.0; 3], [4.0; 3], 1.0).unwrap();
        let signs = signs_of(&ev, &grid);
        let full = dual_contour(&ev, &grid, &signs, u64::MAX).unwrap().mesh;
        let triangles = full.indices.len() as u64 / 3;
        assert_eq!(dual_contour(&ev, &grid, &signs, triangles - 1).err(), Some(OverBudget(triangles)));
        let flat = Grid::new([0.0; 3], [1.0, 1.0, 0.0], 1.0).unwrap();
        assert!(dual_contour(&ev, &flat, &signs_of(&ev, &flat), 10).unwrap().mesh.indices.is_empty());
    }
}
